import { describe, expect, it } from "vitest";
import type { DispatchRequest } from "../src/handler.js";
import { ConversationLanes } from "../src/queue.js";

function makeRequest(conversationId: string, text: string): DispatchRequest {
  return {
    accountId: "1",
    conversationId,
    sessionKey: `chatwoot:1:${conversationId}`,
    text,
    messageId: 1,
    senderId: "1",
    raw: { event: "message_created", id: 1 } as unknown as DispatchRequest["raw"]
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConversationLanes", () => {
  it("serializes turns for the same conversation", async () => {
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatch: async (turn) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(turn.text);
        await delay(10);
        active -= 1;
      }
    });

    await Promise.all([
      lanes.run("chatwoot:1:1", makeRequest("1", "first")),
      lanes.run("chatwoot:1:1", makeRequest("1", "second"))
    ]);

    expect(maxActive).toBe(1);
    expect(seen).toEqual(["first", "second"]);
  });

  it("coalesces a rapid burst into a single turn", async () => {
    const calls: string[] = [];
    const lanes = new ConversationLanes({
      settleMs: 25,
      dispatch: async (turn) => {
        calls.push(turn.text);
      }
    });

    await Promise.all([
      lanes.run("chatwoot:1:1", makeRequest("1", "Oi")),
      lanes.run("chatwoot:1:1", makeRequest("1", "Bom dia"))
    ]);

    expect(calls).toEqual(["Oi\nBom dia"]);
  });

  it("runs different conversations concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
      }
    });

    await Promise.all([
      lanes.run("chatwoot:1:1", makeRequest("1", "a")),
      lanes.run("chatwoot:1:2", makeRequest("2", "b"))
    ]);

    expect(maxActive).toBe(2);
  });

  it("does not hang callers when a dispatch fails and keeps the lane usable", async () => {
    const errors: string[] = [];
    const calls: string[] = [];
    let shouldFail = true;
    const lanes = new ConversationLanes({
      settleMs: 0,
      log: { error: (msg) => errors.push(msg) },
      dispatch: async (turn) => {
        calls.push(turn.text);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("boom");
        }
      }
    });

    await lanes.run("chatwoot:1:1", makeRequest("1", "first"));
    await lanes.run("chatwoot:1:1", makeRequest("1", "second"));

    expect(calls).toEqual(["first", "second"]);
    expect(errors).toContain("chatwoot: lane dispatch failed");
    expect(lanes.pending("chatwoot:1:1")).toBe(0);
  });

  it("dispatches each message separately when coalescing is disabled", async () => {
    const calls: string[] = [];
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatch: async (turn) => {
        calls.push(turn.text);
      }
    });

    await lanes.run("chatwoot:1:1", makeRequest("1", "one"));
    await lanes.run("chatwoot:1:1", makeRequest("1", "two"));

    expect(calls).toEqual(["one", "two"]);
  });

  it("retries with backoff when the gateway is draining, then succeeds", async () => {
    const attempts: number[] = [];
    const warnings: string[] = [];
    let failures = 2;
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatchRetries: 5,
      retryBackoffMs: () => 1,
      log: { warn: (msg) => warnings.push(msg) },
      dispatch: async () => {
        attempts.push(1);
        if (failures > 0) {
          failures -= 1;
          throw new Error("GatewayDrainingError: Gateway is draining; new tasks are not accepted");
        }
      }
    });

    await lanes.run("chatwoot:1:1", makeRequest("1", "hi"));

    expect(attempts).toHaveLength(3);
    expect(warnings).toEqual([
      "chatwoot: gateway draining; deferring lane dispatch",
      "chatwoot: gateway draining; deferring lane dispatch"
    ]);
    expect(lanes.pending("chatwoot:1:1")).toBe(0);
  });

  it("gives up after exhausting draining retries without hanging callers", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatchRetries: 3,
      retryBackoffMs: () => 1,
      log: { error: (msg, ctx) => errors.push({ msg, ctx }) },
      dispatch: async () => {
        attempts += 1;
        throw new Error("GatewayDrainingError: Gateway is draining; new tasks are not accepted");
      }
    });

    await lanes.run("chatwoot:1:1", makeRequest("1", "hi"));

    expect(attempts).toBe(3);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { msg: string }).msg).toBe("chatwoot: lane dispatch failed");
    expect(lanes.pending("chatwoot:1:1")).toBe(0);
  });

  it("does not retry non-draining dispatch failures", async () => {
    let attempts = 0;
    const lanes = new ConversationLanes({
      settleMs: 0,
      dispatchRetries: 5,
      retryBackoffMs: () => 1,
      dispatch: async () => {
        attempts += 1;
        throw new Error("boom");
      }
    });

    await lanes.run("chatwoot:1:1", makeRequest("1", "hi"));

    expect(attempts).toBe(1);
  });
});
