import { describe, expect, it, vi } from "vitest";
import { ChatwootApiError } from "../src/client.js";
import {
  handleConversationEvent,
  handleWebhookEvent,
  recoverPendingEffects,
  type Dispatch,
  type WebhookHandlerDeps
} from "../src/handler.js";
import { createMemoryState } from "../src/state.js";
import { normalizeChannelConfig } from "../src/types.js";
import { makeConversationEvent, makeMessageEvent, MockChatwoot } from "./helpers.js";

const config = normalizeChannelConfig({
  baseUrl: "https://chatwoot.test",
  accountId: 1,
  apiToken: "tok",
  receptionTeamId: 5,
  fallbackModels: ["gpt-4o-mini"],
  handoffNotice: "Connecting you to a teammate.",
  handoffNoteTemplate: "Handoff. Reason: {reason}",
  maxRetries: 2
});

function setup(dispatch: Dispatch) {
  const client = new MockChatwoot();
  const state = createMemoryState();
  const alerts: string[] = [];
  const deps: WebhookHandlerDeps = {
    config,
    state,
    client,
    dispatch,
    onOperatorAlert: (info) => alerts.push(`${info.class}:${info.detail}`)
  };
  return { client, state, deps, alerts };
}

function body(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

describe("webhook handler orchestration", () => {
  it("dispatches a successful inbound message", async () => {
    const dispatch = vi.fn(async () => ({ ok: true, delivered: true }));
    const { state, deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 100 })),
      deps
    );
    expect(result).toMatchObject({ status: 200, action: "dispatched" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.isProcessed("msg:1:100")).toBe(true);
  });

  it("deduplicates duplicate webhooks by Chatwoot message id", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { deps } = setup(dispatch);
    const payload = body(makeMessageEvent({ conversationId: 1, messageId: 100 }));
    const first = await handleWebhookEvent(payload, deps);
    const second = await handleWebhookEvent(payload, deps);
    expect(first.action).toBe("dispatched");
    expect(second).toMatchObject({ action: "duplicate" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps conversations isolated by session key", async () => {
    const seen: Array<{ conv: string; session: string }> = [];
    const dispatch: Dispatch = async (request) => {
      seen.push({ conv: request.conversationId, session: request.sessionKey });
      return { ok: true };
    };
    const { deps } = setup(dispatch);
    await handleWebhookEvent(body(makeMessageEvent({ conversationId: 1, messageId: 1 })), deps);
    await handleWebhookEvent(body(makeMessageEvent({ conversationId: 2, messageId: 2 })), deps);
    expect(seen).toEqual([
      { conv: "1", session: "chatwoot:1:1" },
      { conv: "2", session: "chatwoot:1:2" }
    ]);
  });

  it("retries transient model errors then succeeds", async () => {
    let calls = 0;
    const dispatch: Dispatch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, error: new Error("fetch failed") };
      return { ok: true };
    };
    const { deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 1 })),
      deps
    );
    expect(result.action).toBe("dispatched");
    expect(calls).toBe(2);
  });

  it("falls back to another model on quota exhaustion", async () => {
    const models: Array<string | undefined> = [];
    const dispatch: Dispatch = async (request) => {
      models.push(request.model);
      if (!request.model) return { ok: false, error: { status: 429, code: "insufficient_quota" } };
      return { ok: true, model: request.model };
    };
    const { deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 1 })),
      deps
    );
    expect(result.action).toBe("dispatched-fallback");
    expect(models).toEqual([undefined, "gpt-4o-mini"]);
  });

  it("hands off to reception when quota is exhausted and no fallback remains", async () => {
    const dispatch: Dispatch = async () => ({
      ok: false,
      error: { status: 429, code: "insufficient_quota" }
    });
    const { client, state, deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 7, messageId: 1 })),
      deps
    );
    expect(result.action).toBe("handoff");
    expect(state.isHandoffActive("chatwoot:1:7")).toBe(true);
    expect(client.assignments).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(1);
  });

  it("alerts the operator on auth errors without messaging the customer", async () => {
    const dispatch: Dispatch = async () => ({ ok: false, error: { status: 401 } });
    const { client, deps, alerts } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 1 })),
      deps
    );
    expect(result).toMatchObject({ action: "alerted", reason: "auth" });
    expect(alerts).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(0);
    expect(client.privateMessages()).toHaveLength(0);
  });

  it("hands off on outbound Chatwoot delivery failure", async () => {
    const dispatch: Dispatch = async () => {
      throw new ChatwootApiError("send failed", 500);
    };
    const { client, deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 8, messageId: 1 })),
      deps
    );
    expect(result).toMatchObject({ action: "handoff", reason: "delivery" });
    expect(client.assignments).toHaveLength(1);
  });

  it("suppresses automatic replies while human handling is active", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    await state.setHandoff("chatwoot:1:9", { active: true, updatedAt: new Date().toISOString() });
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 9, messageId: 50 })),
      deps
    );
    expect(result).toMatchObject({ action: "suppressed-handoff" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("resumes automation when reception returns the conversation to the bot", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    await state.setHandoff("chatwoot:1:12", { active: true, updatedAt: new Date().toISOString() });

    const resume = await handleConversationEvent(
      body(makeConversationEvent({ conversationId: 12, teamId: 99 })),
      deps
    );
    expect(resume.action).toBe("resumed");
    expect(state.isHandoffActive("chatwoot:1:12")).toBe(false);

    const after = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 12, messageId: 60 })),
      deps
    );
    expect(after.action).toBe("dispatched");
  });

  it("does not resume while reception still owns the conversation", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    await state.setHandoff("chatwoot:1:13", { active: true, updatedAt: new Date().toISOString() });
    const result = await handleConversationEvent(
      body(makeConversationEvent({ conversationId: 13, teamId: 5 })),
      deps
    );
    expect(result).toMatchObject({ action: "ignored", reason: "handoff-still-active" });
    expect(state.isHandoffActive("chatwoot:1:13")).toBe(true);
  });

  it("rejects webhooks with a bad signature when a secret is configured", async () => {
    const secured = normalizeChannelConfig({ ...config, webhookSecret: "s3cret" });
    const client = new MockChatwoot();
    const state = createMemoryState();
    const dispatch = vi.fn(async () => ({ ok: true }));
    const deps: WebhookHandlerDeps = { config: secured, state, client, dispatch };
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 1 })),
      deps
    );
    expect(result).toMatchObject({ status: 401, action: "rejected" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers interrupted handoff side effects after a restart", async () => {
    const client = new MockChatwoot();
    const state = createMemoryState();
    // Simulate a handoff that was recorded but crashed before side effects ran.
    await state.setHandoff("chatwoot:1:20", { active: true, updatedAt: new Date().toISOString() });
    await state.putEffect("chatwoot:1:20", {
      id: "handoff-note",
      kind: "handoff-note",
      status: "pending",
      attempts: 1,
      updatedAt: new Date().toISOString()
    });

    const recovered = await recoverPendingEffects({ state, client, config });
    expect(recovered).toBe(1);
    expect(client.privateMessages()).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(1);
    expect(client.assignments).toHaveLength(1);
  });
});
