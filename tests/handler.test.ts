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

  it("ignores webhooks from a different Chatwoot account", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ accountId: 99, conversationId: 1, messageId: 7 })),
      deps
    );
    expect(result).toMatchObject({ status: 200, action: "ignored", reason: "account-mismatch" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores conversation lifecycle events from a different account", async () => {
    const { state, deps } = setup(vi.fn(async () => ({ ok: true })));
    // Seed an active handoff on the configured account (1).
    await state.setHandoff("chatwoot:1:1", { active: true, updatedAt: "2026-01-01T00:00:00.000Z" });
    const result = await handleConversationEvent(
      body(makeConversationEvent({ accountId: 99, conversationId: 1, status: "resolved" })),
      deps
    );
    expect(result).toMatchObject({ status: 200, action: "ignored", reason: "account-mismatch" });
    expect(state.isHandoffActive("chatwoot:1:1")).toBe(true);
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

  it("delegates model failover to core and never re-dispatches a plugin-chosen model", async () => {
    const calls: Array<string | undefined> = [];
    const dispatch: Dispatch = async (request) => {
      calls.push(request.model);
      return { ok: false, error: { status: 429, code: "insufficient_quota" } };
    };
    const { client, deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 6, messageId: 1 })),
      deps
    );
    expect(result).toMatchObject({ action: "handoff", reason: "quota" });
    expect(calls).toEqual([undefined]);
    expect(client.assignments).toHaveLength(1);
  });

  it("accepts a native Chatwoot signed webhook and rejects a stale timestamp", async () => {
    const { signChatwootPayload } = await import("../src/webhook.js");
    const secured = normalizeChannelConfig({
      ...config,
      webhookSecret: "s3cret",
      webhookTimestampToleranceSec: 300
    });
    const client = new MockChatwoot();
    const state = createMemoryState();
    const dispatch = vi.fn(async () => ({ ok: true }));
    const raw = body(makeMessageEvent({ conversationId: 3, messageId: 7 }));
    const nowMs = Date.parse("2026-01-01T00:00:00Z");
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = signChatwootPayload(raw, timestamp, "s3cret");

    const ok = await handleWebhookEvent(raw, {
      config: secured,
      state,
      client,
      dispatch,
      signatureHeader: signature,
      timestampHeader: timestamp,
      now: () => new Date(nowMs)
    });
    expect(ok).toMatchObject({ status: 200, action: "dispatched" });

    const stale = await handleWebhookEvent(raw, {
      config: secured,
      state: createMemoryState(),
      client,
      dispatch,
      signatureHeader: signature,
      timestampHeader: timestamp,
      now: () => new Date(nowMs + 10 * 60 * 1000)
    });
    expect(stale).toMatchObject({ status: 401, action: "rejected", reason: "bad-signature" });
  });

  it("deduplicates replay by X-Chatwoot-Delivery id", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { deps } = setup(dispatch);
    const first = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 4, messageId: 11 })),
      { ...deps, deliveryId: "delivery-abc" }
    );
    // Same delivery id, different message id: only the delivery dedupe applies.
    const second = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 4, messageId: 12 })),
      { ...deps, deliveryId: "delivery-abc" }
    );
    expect(first.action).toBe("dispatched");
    expect(second).toMatchObject({ action: "duplicate", reason: "delivery-replayed" });
    expect(dispatch).toHaveBeenCalledTimes(1);
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
