import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareInboundAck, type DispatchRequest } from "../src/handler.js";
import { DurableState } from "../src/state.js";
import { Spool, spoolKey, type SpoolRecord } from "../src/spool.js";
import type { ChatwootChannelConfig } from "../src/types.js";
import { signChatwootPayload } from "../src/webhook.js";
import { makeMessageEvent } from "./helpers.js";

const config: ChatwootChannelConfig = {
  baseUrl: "http://chatwoot:3000",
  accountId: 3,
  apiToken: "t",
  webhookSecret: "s3cret",
  botInboxIds: [4]
};

async function freshSpool(): Promise<Spool> {
  const dir = await mkdtemp(join(tmpdir(), "cw-ack-"));
  const spool = new Spool({ rootDir: dir });
  await spool.init();
  return spool;
}

function signed(body: string) {
  const timestamp = "1700000000";
  return {
    timestampHeader: timestamp,
    signatureHeader: signChatwootPayload(body, timestamp, config.webhookSecret as string),
    // match the signature timestamp so the replay-window check passes
    now: () => new Date(Number(timestamp) * 1000 + 60_000)
  };
}

const recordFor = (request: DispatchRequest): SpoolRecord => ({
  key: spoolKey(request.accountId, request.messageId ?? 0),
  accountId: request.accountId,
  conversationId: request.conversationId,
  messageId: request.messageId,
  text: request.text,
  senderId: request.senderId,
  statusAtReceipt: request.raw.conversation?.status,
  receivedAt: new Date().toISOString(),
  availableAt: new Date(Date.now() + 1000).toISOString(),
  attempt: 0,
  source: "webhook",
  payload: request.raw as Record<string, unknown>
});

describe("prepareInboundAck with durable spool", () => {
  it("persists the record BEFORE returning 200 and does not dispatch inline", async () => {
    const spool = await freshSpool();
    const state = DurableState.open();
    const dispatchCalls: DispatchRequest[] = [];
    const body = JSON.stringify(
      makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 777, status: "pending", inboxId: 4 })
    );
    const ack = await prepareInboundAck(body, {
      config,
      state,
      dispatch: async (request) => {
        dispatchCalls.push(request);
      },
      ...signed(body)
    }, { spool, recordFor });
    expect(ack.status).toBe(200);
    expect(ack.action).toBe("accepted");
    // the agent was NOT invoked by the webhook path
    expect(dispatchCalls.length).toBe(0);
    // the record IS durably queued already
    const inbox = await spool.list("inbox");
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.text).toBe("hello");
    expect(inbox[0]?.messageId).toBe(777);
  });

  it("answers duplicate when the same message id is delivered again", async () => {
    const spool = await freshSpool();
    const state = DurableState.open();
    const body = JSON.stringify(
      makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 778, status: "pending", inboxId: 4 })
    );
    const deps = {
      config,
      state,
      dispatch: async () => {},
      ...signed(body)
    };
    const first = await prepareInboundAck(body, deps, { spool, recordFor });
    expect(first.action).toBe("accepted");
    const second = await prepareInboundAck(body, deps, { spool, recordFor });
    // dedup happens on the state claim first; either 200 duplicate variant is fine
    expect(second.status).toBe(200);
    expect(second.action).toBe("duplicate");
    expect((await spool.list("inbox")).length).toBe(1);
  });

  it("still rejects invalid signatures with 401 and queues nothing", async () => {
    const spool = await freshSpool();
    const state = DurableState.open();
    const body = JSON.stringify(makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 779 }));
    const ack = await prepareInboundAck(
      body,
      { config, state, dispatch: async () => {}, signatureHeader: "sha256=deadbeef", timestampHeader: "1700000000" },
      { spool, recordFor }
    );
    expect(ack.status).toBe(401);
    expect((await spool.list("inbox")).length).toBe(0);
  });

  it("keeps the legacy inline path when no spool is provided", async () => {
    const state = DurableState.open();
    const dispatchCalls: DispatchRequest[] = [];
    const body = JSON.stringify(makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 780 }));
    const ack = await prepareInboundAck(body, {
      config,
      state,
      dispatch: async (request) => {
        dispatchCalls.push(request);
      },
      ...signed(body)
    });
    expect(ack.status).toBe(200);
    expect(ack.action).toBe("dispatched");
    expect(ack.request).toBeDefined();
  });

  it("acknowledges 200 with queue-degraded when spool persistence fails", async () => {
    const state = DurableState.open();
    const broken = {
      init: async () => {
        throw new Error("read-only filesystem");
      },
      accept: async () => true,
      list: async () => []
    } as unknown as Spool;
    const body = JSON.stringify(
      makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 781, status: "pending", inboxId: 4 })
    );
    const ack = await prepareInboundAck(
      body,
      { config, state, dispatch: async () => {}, ...signed(body) },
      { spool: broken, recordFor }
    );
    expect(ack.status).toBe(200);
    expect(ack.action).toBe("accepted");
    expect(ack.reason).toBe("queue-degraded");
  });

  it("rolls back the dedupe claim on degraded accept so a redelivery can retry", async () => {
    const state = DurableState.open();
    let fail = true;
    const flaky = {
      init: async () => {
        if (fail) throw new Error("disk full");
      },
      accept: async () => true,
      list: async () => []
    } as unknown as Spool;
    const body = JSON.stringify(
      makeMessageEvent({ accountId: 3, conversationId: 112, messageId: 782, status: "pending", inboxId: 4 })
    );
    const deps = { config, state, dispatch: async () => {}, ...signed(body) };
    const first = await prepareInboundAck(body, deps, { spool: flaky, recordFor });
    expect(first.reason).toBe("queue-degraded");
    fail = false;
    const second = await prepareInboundAck(body, deps, { spool: flaky, recordFor });
    expect(second.status).toBe(200);
    expect(second.action).toBe("accepted");
  });
});
