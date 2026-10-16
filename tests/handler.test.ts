import { describe, expect, it, vi } from "vitest";
import {
  handleConversationEvent,
  handleWebhookEvent,
  type Dispatch,
  type WebhookHandlerDeps
} from "../src/handler.js";
import { createMemoryState } from "../src/state.js";
import { normalizeChannelConfig } from "../src/types.js";
import { makeConversationEvent, makeMessageEvent } from "./helpers.js";

const config = normalizeChannelConfig({
  baseUrl: "https://chatwoot.test",
  accountId: 1,
  apiToken: "tok",
  receptionTeamId: 5,
  fallbackModels: ["gpt-4o-mini"]
});

function setup(dispatch: Dispatch) {
  const state = createMemoryState();
  const deps: WebhookHandlerDeps = {
    config,
    state,
    dispatch
  };
  return { state, deps };
}

function body(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

describe("webhook handler orchestration (simplified async adapter)", () => {
  it("dispatches a successful inbound message asynchronously and acks 200", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1, messageId: 100 })),
      deps
    );
    expect(result).toMatchObject({ status: 200, action: "dispatched" });
    // Allow background dispatch tick
    await new Promise((r) => setTimeout(r, 10));
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
    await new Promise((r) => setTimeout(r, 10));
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
    await new Promise((r) => setTimeout(r, 10));
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
    await state.setHandoff("chatwoot:1:1", { active: true, updatedAt: "2026-01-01T00:00:00.000Z" });
    const result = await handleConversationEvent(
      body(makeConversationEvent({ accountId: 99, conversationId: 1, status: "resolved" })),
      deps
    );
    expect(result).toMatchObject({ status: 200, action: "ignored", reason: "account-mismatch" });
    expect(state.isHandoffActive("chatwoot:1:1")).toBe(true);
  });

  it("accepts a native Chatwoot signed webhook and rejects a stale timestamp", async () => {
    const { signChatwootPayload } = await import("../src/webhook.js");
    const secured = normalizeChannelConfig({
      ...config,
      webhookSecret: "s3cret",
      webhookTimestampToleranceSec: 300
    });
    const state = createMemoryState();
    const dispatch = vi.fn(async () => ({ ok: true }));
    const raw = body(makeMessageEvent({ conversationId: 3, messageId: 7 }));
    const nowMs = Date.parse("2026-01-01T00:00:00Z");
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = signChatwootPayload(raw, timestamp, "s3cret");

    const ok = await handleWebhookEvent(raw, {
      config: secured,
      state,
      dispatch,
      signatureHeader: signature,
      timestampHeader: timestamp,
      now: () => new Date(nowMs)
    });
    expect(ok).toMatchObject({ status: 200, action: "dispatched" });

    const stale = await handleWebhookEvent(raw, {
      config: secured,
      state: createMemoryState(),
      dispatch,
      signatureHeader: signature,
      timestampHeader: timestamp,
      now: () => new Date(nowMs + 10 * 60 * 1000)
    });
    expect(stale).toMatchObject({ status: 401, action: "rejected", reason: "bad-signature" });
  });

  it("rejects an invalid signature with 401", async () => {
    const secured = normalizeChannelConfig({ ...config, webhookSecret: "s3cret" });
    const { state } = setup(vi.fn());
    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 1 })),
      {
        config: secured,
        state,
        dispatch: vi.fn(),
        signatureHeader: "bad"
      }
    );
    expect(result.status).toBe(401);
  });

  it("suppresses inbound while human handoff is active", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    await state.setHandoff("chatwoot:1:11", { active: true, updatedAt: new Date().toISOString() });

    const result = await handleWebhookEvent(
      body(makeMessageEvent({ conversationId: 11, messageId: 50 })),
      deps
    );
    expect(result).toMatchObject({ action: "suppressed-handoff" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("resumes automation when conversation is resolved", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const { state, deps } = setup(dispatch);
    await state.setHandoff("chatwoot:1:12", { active: true, updatedAt: new Date().toISOString() });

    const resume = await handleConversationEvent(
      body(makeConversationEvent({ conversationId: 12, status: "resolved" })),
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
});
