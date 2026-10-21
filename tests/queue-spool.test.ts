import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpoolQueue, type ReconcileSource } from "../src/queue-spool.js";
import { Spool, spoolKey, type SpoolRecord } from "../src/spool.js";
import type { DispatchRequest } from "../src/handler.js";
import type { ChatwootChannelConfig } from "../src/types.js";

const config: ChatwootChannelConfig = {
  baseUrl: "http://chatwoot:3000",
  accountId: 3,
  apiToken: "t",
  botInboxIds: [4]
};

async function freshSpool(): Promise<Spool> {
  const dir = await mkdtemp(join(tmpdir(), "cw-spool-"));
  const spool = new Spool({ rootDir: dir });
  await spool.init();
  return spool;
}

function record(overrides: Partial<SpoolRecord> = {}): SpoolRecord {
  const now = new Date("2026-10-21T12:00:00.000Z");
  return {
    key: spoolKey("3", 100),
    accountId: "3",
    conversationId: "112",
    inboxId: "4",
    messageId: 100,
    text: "oi",
    statusAtReceipt: "pending",
    receivedAt: now.toISOString(),
    availableAt: new Date(now.getTime() - 1000).toISOString(),
    attempt: 0,
    source: "webhook",
    payload: { event: "message_created", id: 100 },
    ...overrides
  };
}

function requestFromRecord(rec: SpoolRecord): DispatchRequest {
  return {
    accountId: rec.accountId,
    conversationId: rec.conversationId,
    sessionKey: `chatwoot:${rec.accountId}:${rec.conversationId}`,
    text: rec.text,
    messageId: rec.messageId,
    raw: rec.payload as DispatchRequest["raw"]
  };
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 3000, step = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timed out");
}

describe("spool queue dispatch", () => {
  it("dispatches a due record and marks it completed", async () => {
    const spool = await freshSpool();
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => {
        calls.push(request);
      },
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await spool.accept(record());
    await queue.start();
    await waitFor(() => calls.length === 1);
    await waitFor(async () => (await spool.list("completed")).length === 1);
    expect((await spool.list("inbox")).length).toBe(0);
    expect((await spool.list("processing")).length).toBe(0);
    expect(calls[0]?.text).toBe("oi");
    queue.stop();
  });

  it("coalesces same-conversation records into one batch, in arrival order", async () => {
    const spool = await freshSpool();
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => {
        calls.push(request);
      },
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await spool.accept(record({ key: spoolKey("3", 201), messageId: 201, text: "Oi", receivedAt: "2026-10-21T12:00:00.000Z" }));
    await spool.accept(record({ key: spoolKey("3", 202), messageId: 202, text: "Tudo bem?", receivedAt: "2026-10-21T12:00:01.000Z" }));
    await spool.accept(record({ key: spoolKey("3", 203), messageId: 203, text: "Qual o endereco?", receivedAt: "2026-10-21T12:00:02.000Z" }));
    await queue.start();
    await waitFor(() => calls.length >= 1);
    // give a second tick a chance to leak a stray turn
    await new Promise((r) => setTimeout(r, 150));
    const first = calls[0]!;
    expect(first.text.split("\n")).toEqual(["Oi", "Tudo bem?", "Qual o endereco?"]);
    expect(calls.length).toBe(1);
    queue.stop();
  });

  it("keeps different conversations on separate batches", async () => {
    const spool = await freshSpool();
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await spool.accept(record({ key: spoolKey("3", 301), messageId: 301, conversationId: "112", text: "A" }));
    await spool.accept(record({ key: spoolKey("3", 302), messageId: 302, conversationId: "113", text: "B" }));
    await queue.start();
    await waitFor(() => calls.length === 2);
    expect(calls.map((c) => c.conversationId).sort()).toEqual(["112", "113"]);
    queue.stop();
  });

  it("retries transient gateway-draining failures and eventually succeeds", async () => {
    const spool = await freshSpool();
    let attempts = 0;
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Gateway is draining; new tasks are not accepted");
      },
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0,
      retryBackoffMs: () => 10
    });
    await spool.accept(record());
    await queue.start();
    await waitFor(() => attempts >= 3);
    await waitFor(async () => (await spool.list("completed")).length === 1);
    queue.stop();
    expect(attempts).toBe(3);
  });

  it("moves records to failed/ after retries are exhausted and notes the conversation", async () => {
    const spool = await freshSpool();
    const notes: string[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async () => {
        throw new Error("model exploded");
      },
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0,
      maxAttempts: 2,
      retryBackoffMs: () => 5,
      privateNote: async (rec, reason) => {
        notes.push(`${rec.messageId}:${reason}`);
      }
    });
    await spool.accept(record());
    await queue.start();
    await waitFor(async () => (await spool.list("failed")).length === 1);
    queue.stop();
    expect(notes.length).toBe(1);
    const [failed] = await spool.list("failed");
    expect(failed?.lastError).toContain("model exploded");
  });

  it("requeues records received while a human owns the conversation until it is pending again", async () => {
    const spool = await freshSpool();
    const calls: DispatchRequest[] = [];
    let status = "open";
    const client: ReconcileSource = {
      listConversations: async () => [],
      listConversationMessages: async () => [],
      getConversation: async () => ({ id: 112, status, inbox_id: 4 })
    };
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      client,
      tickMs: 10,
      settleMs: 0,
      humanRecheckMs: 100
    });
    await spool.accept(record({ statusAtReceipt: "open" }));
    await queue.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(0);
    status = "pending";
    await waitFor(() => calls.length === 1, 5000);
    queue.stop();
  });

  it("recovers expired leases from processing/ on startup", async () => {
    const spool = await freshSpool();
    // simulate a crashed dispatch: record in processing/ with an expired lease
    const rec = record();
    await spool.accept(rec);
    const [due] = await spool.list("inbox");
    await spool.claim(due!, new Date("2000-01-01").toISOString());
    expect((await spool.list("processing")).length).toBe(1);

    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await queue.start();
    await waitFor(() => calls.length === 1);
    queue.stop();
  });

  it("does not re-dispatch a record that a previous process completed", async () => {
    const spool = await freshSpool();
    await spool.accept(record());
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await queue.start();
    await waitFor(() => calls.length === 1);
    queue.stop();
    // restart worker on the same spool
    const queue2 = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      tickMs: 10,
      settleMs: 0
    });
    await queue2.start();
    await new Promise((r) => setTimeout(r, 80));
    queue2.stop();
    expect(calls.length).toBe(1);
  });
});

describe("spool queue reconcile", () => {
  it("recovers customer messages the spool never accepted", async () => {
    const spool = await freshSpool();
    const now = new Date("2026-10-21T12:30:00.000Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    const client: ReconcileSource = {
      listConversations: async () => [
        { id: 112, status: "pending", inbox_id: 4, last_activity_at: nowSec }
      ],
      listConversationMessages: async () => [
        { id: 401, content: "lost message", message_type: 0, private: false, created_at: nowSec, sender: { id: 11, type: "contact" } } as never,
        { id: 402, content: "bot reply", message_type: 1, private: false, created_at: nowSec, sender: { type: "user" } } as never
      ],
      getConversation: async () => ({ id: 112, status: "pending", inbox_id: 4 })
    };
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      client,
      tickMs: 10,
      settleMs: 0,
      reconcileIntervalMs: 30,
      now: () => now,
      reconcileLookbackSec: 3600
    });
    await queue.start();
    await waitFor(() => calls.length === 1);
    queue.stop();
    expect(calls[0]?.text).toBe("lost message");
    expect(calls[0]?.messageId).toBe(401);
  });

  it("skips conversations on non-bot inboxes", async () => {
    const spool = await freshSpool();
    const nowSec = Math.floor(Date.now() / 1000);
    const client: ReconcileSource = {
      listConversations: async () => [
        { id: 9, status: "pending", inbox_id: 99, last_activity_at: nowSec }
      ],
      listConversationMessages: async () => [
        { id: 500, content: "nope", message_type: 0, private: false, created_at: nowSec, sender: { id: 11, type: "contact" } } as never
      ],
      getConversation: async () => ({ id: 9, status: "pending", inbox_id: 99 })
    };
    const calls: DispatchRequest[] = [];
    const queue = new SpoolQueue({
      spool,
      config,
      dispatch: async (request) => calls.push(request),
      toRequest: requestFromRecord,
      client,
      tickMs: 10,
      settleMs: 0,
      reconcileIntervalMs: 30,
      now: () => new Date("2026-10-21T12:30:00.000Z")
    });
    await queue.start();
    await new Promise((r) => setTimeout(r, 120));
    queue.stop();
    expect(calls.length).toBe(0);
  });
});
