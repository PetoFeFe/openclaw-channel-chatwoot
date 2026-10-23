import { describe, expect, it } from "vitest";
import {
  classifyInbound,
  isAccountAllowed,
  parseWebhook,
  signChatwootPayload,
  signWebhookBody,
  verifyChatwootSignature,
  verifyWebhookSignature,
  isIncomingMessageType
} from "../src/webhook.js";
import type { ChatwootChannelConfig } from "../src/types.js";
import { makeMessageEvent } from "./helpers.js";

const config = (accountId: string | number): ChatwootChannelConfig => ({
  baseUrl: "http://chatwoot:3000",
  accountId,
  apiToken: "t"
});

describe("webhook authentication", () => {
  it("accepts a valid HMAC signature", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const secret = "s3cret";
    const sig = signWebhookBody(body, secret);
    expect(verifyWebhookSignature({ rawBody: body, secret, headerValue: sig })).toBe(true);
    expect(verifyWebhookSignature({ rawBody: body, secret, headerValue: `sha256=${sig}` })).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    expect(verifyWebhookSignature({ rawBody: body, secret: "s3cret", headerValue: "deadbeef" })).toBe(
      false
    );
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const sig = signWebhookBody(body, "s3cret");
    expect(
      verifyWebhookSignature({ rawBody: `${body} `, secret: "s3cret", headerValue: sig })
    ).toBe(false);
  });

  it("allows requests when no secret is configured", () => {
    expect(verifyWebhookSignature({ rawBody: "{}", secret: undefined, headerValue: undefined })).toBe(
      true
    );
  });

  it("accepts a native Chatwoot signature within the replay window", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const timestamp = "1700000000";
    const signature = signChatwootPayload(body, timestamp, "s3cret");
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(
      verifyChatwootSignature({
        rawBody: body,
        secret: "s3cret",
        signatureHeader: signature,
        timestampHeader: timestamp,
        nowMs: 1700000000 * 1000
      })
    ).toBe(true);
  });

  it("rejects a native Chatwoot signature outside the replay window", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const timestamp = "1700000000";
    const signature = signChatwootPayload(body, timestamp, "s3cret");
    expect(
      verifyChatwootSignature({
        rawBody: body,
        secret: "s3cret",
        signatureHeader: signature,
        timestampHeader: timestamp,
        toleranceSec: 300,
        nowMs: 1700000000 * 1000 + 10 * 60 * 1000
      })
    ).toBe(false);
  });

  it("rejects a native Chatwoot signature for a tampered body", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const timestamp = "1700000000";
    const signature = signChatwootPayload(body, timestamp, "s3cret");
    expect(
      verifyChatwootSignature({
        rawBody: `${body} `,
        secret: "s3cret",
        signatureHeader: signature,
        timestampHeader: timestamp,
        nowMs: 1700000000 * 1000
      })
    ).toBe(false);
  });

  it("requires both native header values when a secret is set", () => {
    expect(
      verifyChatwootSignature({ rawBody: "{}", secret: "s3cret", signatureHeader: "sha256=x" })
    ).toBe(false);
  });
});

describe("webhook parsing and filtering", () => {
  it("dispatches customer incoming messages", () => {
    const decision = classifyInbound(parseWebhook(JSON.stringify(makeMessageEvent({ conversationId: 5 }))));
    expect(decision.action).toBe("dispatch");
    expect(decision.conversationId).toBe("5");
    expect(decision.messageId).toBe(1);
  });

  it("ignores outgoing agent messages", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ conversationId: 5, messageType: "outgoing" })))
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "not-incoming" });
  });

  it("ignores private notes", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ conversationId: 5, priv: true })))
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "private" });
  });

  it("ignores messages authored by agents/bots", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ conversationId: 5, senderType: "agent" })))
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "self-authored" });
  });

  it("ignores empty content", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ conversationId: 5, content: "   " })))
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "empty-content" });
  });

  it("ignores non-message events", () => {
    const decision = classifyInbound(parseWebhook(JSON.stringify({ event: "conversation_updated" })));
    expect(decision).toMatchObject({ action: "ignore", reason: "event-not-message" });
  });

  it("treats message_updated like message_created", () => {
    const decision = classifyInbound(
      parseWebhook(
        JSON.stringify({
          ...makeMessageEvent({ conversationId: 5, messageId: 9 }),
          event: "message_updated"
        })
      )
    );
    expect(decision).toMatchObject({ action: "dispatch", messageId: 9, conversationId: "5" });
  });

  it("ignores messages from a different account than configured", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ accountId: 9, conversationId: 5 }))),
      config(3)
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "account-mismatch" });
  });

  it("dispatches messages from the configured account and scopes the session key", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ accountId: 3, conversationId: 5 }))),
      config(3)
    );
    expect(decision).toMatchObject({ action: "dispatch", accountId: "3", conversationId: "5" });
  });

  it("pins the session account to config even when the payload omits account", () => {
    const event = makeMessageEvent({ conversationId: 5 });
    delete event.account;
    const decision = classifyInbound(parseWebhook(JSON.stringify(event)), config(3));
    expect(decision).toMatchObject({ action: "dispatch", accountId: "3", conversationId: "5" });
  });

  it("isAccountAllowed tolerates missing account ids", () => {
    expect(isAccountAllowed({}, config(3))).toBe(true);
    expect(isAccountAllowed({ account: { id: 3 } }, config(3))).toBe(true);
    expect(isAccountAllowed({ account: { id: "3" } }, config(3))).toBe(true);
    expect(isAccountAllowed({ account: { id: 4 } }, config(3))).toBe(false);
  });

  it("tolerates numeric strings for message and conversation ids", () => {
    const event = makeMessageEvent({ conversationId: 5, messageId: 9 });
    event.id = "9";
    (event.conversation as { id: number | string }).id = "5";
    const decision = classifyInbound(parseWebhook(JSON.stringify(event)));
    expect(decision).toMatchObject({ action: "dispatch", conversationId: "5", messageId: 9 });
  });
});

describe("AgentBot webhook support", () => {
  const botConfig = (overrides: Partial<ChatwootChannelConfig> = {}): ChatwootChannelConfig => ({
    baseUrl: "http://chatwoot:3000",
    accountId: 3,
    apiToken: "t",
    ...overrides
  });

  it("accepts signatures from either the webhook secret or the AgentBot secret", () => {
    const body = JSON.stringify(makeMessageEvent({ conversationId: 1 }));
    const timestamp = "1700000000";
    const nowMs = (Number(timestamp) + 60) * 1000;
    const accountSig = signChatwootPayload(body, timestamp, "account-secret");
    const botSig = signChatwootPayload(body, timestamp, "bot-secret");
    const otherSig = signChatwootPayload(body, timestamp, "wrong-secret");
    const base = {
      rawBody: body,
      timestampHeader: timestamp,
      toleranceSec: 300,
      nowMs,
      secret: "account-secret",
      additionalSecrets: ["bot-secret"]
    };
    expect(verifyChatwootSignature({ ...base, signatureHeader: accountSig })).toBe(true);
    expect(verifyChatwootSignature({ ...base, signatureHeader: botSig })).toBe(true);
    expect(verifyChatwootSignature({ ...base, signatureHeader: otherSig })).toBe(false);
  });

  it("dispatches pending bot-owned messages on a bot inbox", () => {
    const decision = classifyInbound(
      parseWebhook(
        JSON.stringify(
          makeMessageEvent({ accountId: 3, conversationId: 120, inboxId: 4, status: "pending" })
        )
      ),
      botConfig()
    );
    expect(decision).toMatchObject({
      action: "dispatch",
      conversationId: "120",
      conversationStatus: "pending",
      inboxId: "4"
    });
  });

  it("dispatches human-owned messages too — the AGENT owns the handoff decision", () => {
    // v0.4: ingress never filters on conversation status. Human takeover is
    // decided by Tata from the live status in the inbound prompt, not here.
    for (const status of ["open", "snoozed"]) {
      const decision = classifyInbound(
        parseWebhook(
          JSON.stringify(
            makeMessageEvent({ accountId: 3, conversationId: 120, inboxId: 4, status })
          )
        ),
        botConfig()
      );
      expect(decision).toMatchObject({
        action: "dispatch",
        reason: "incoming",
        conversationId: "120",
        conversationStatus: status
      });
    }
  });

  it("does not apply status filtering on non-bot inboxes either", () => {
    const decision = classifyInbound(
      parseWebhook(
        JSON.stringify(
          makeMessageEvent({ accountId: 3, conversationId: 5, inboxId: 3, status: "open" })
        )
      ),
      botConfig()
    );
    expect(decision).toMatchObject({ action: "dispatch", conversationStatus: "open" });
  });

  it("accepts integer message_type from nested/push payloads", () => {
    const decision = classifyInbound(
      parseWebhook(
        JSON.stringify(
          makeMessageEvent({
            accountId: 3,
            conversationId: 120,
            inboxId: 4,
            status: "pending",
            messageType: 0
          })
        )
      ),
      botConfig()
    );
    expect(decision).toMatchObject({ action: "dispatch", conversationId: "120" });

    const outgoing = classifyInbound(
      parseWebhook(JSON.stringify(makeMessageEvent({ accountId: 3, conversationId: 120, messageType: 1 }))),
      botConfig()
    );
    expect(outgoing).toMatchObject({ action: "ignore", reason: "not-incoming" });
  });

  it("falls back to nested conversation.messages content", () => {
    const event = makeMessageEvent({ accountId: 3, conversationId: 120, inboxId: 4, status: "pending" });
    event.content = "";
    (event.conversation as Record<string, unknown>).messages = [{ id: 77, content: "bom dia" }];
    const decision = classifyInbound(parseWebhook(JSON.stringify(event)), botConfig());
    expect(decision).toMatchObject({ action: "dispatch", text: "bom dia", conversationId: "120" });
  });

  it("prefers conversation_id (display id) over the nested raw id", () => {
    const event = makeMessageEvent({ accountId: 3, conversationId: 120, inboxId: 4, status: "pending" });
    event.conversation_id = 120;
    (event.conversation as Record<string, unknown>).id = 999; // raw DB id
    const decision = classifyInbound(parseWebhook(JSON.stringify(event)), botConfig());
    expect(decision).toMatchObject({ action: "dispatch", conversationId: "120" });
  });
});

describe("isIncomingMessageType", () => {
  it("accepts the string enum and integer 0 only", () => {
    expect(isIncomingMessageType("incoming")).toBe(true);
    expect(isIncomingMessageType(0)).toBe(true);
    expect(isIncomingMessageType(1)).toBe(false);
    expect(isIncomingMessageType(2)).toBe(false);
    expect(isIncomingMessageType("outgoing")).toBe(false);
    expect(isIncomingMessageType(undefined)).toBe(false);
  });
});

describe("audio attachments (voice notes)", () => {
  const audioMsg = (overrides: Record<string, unknown> = {}) => ({
    event: "message_created",
    id: 900,
    content: "",
    message_type: "incoming",
    private: false,
    content_type: "text",
    account: { id: 3 },
    conversation: { id: 112, status: "pending", inbox_id: 4 },
    inbox: { id: 4, name: "TauiTest_bot" },
    sender: { id: 11, type: "contact" },
    attachments: [
      { id: 55, file_type: "audio", data_url: "https://cw.test/a.ogg", content_type: "audio/ogg" }
    ],
    ...overrides
  });

  it("dispatches audio-only messages (no text) with audioAttachments", () => {
    const decision = classifyInbound(parseWebhook(JSON.stringify(audioMsg())));
    expect(decision).toMatchObject({ action: "dispatch", reason: "incoming" });
    expect(decision.audioAttachments?.[0]?.data_url).toBe("https://cw.test/a.ogg");
  });

  it("keeps text and audio together", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(audioMsg({ content: "olá" })))
    );
    expect(decision.action).toBe("dispatch");
    expect(decision.text).toBe("olá");
    expect(decision.audioAttachments?.length).toBe(1);
  });

  it("ignores text-less messages without audio attachments", () => {
    const decision = classifyInbound(
      parseWebhook(JSON.stringify(audioMsg({ attachments: [] })))
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "empty-content" });
  });

  it("ignores non-audio attachments when there is no text", () => {
    const decision = classifyInbound(
      parseWebhook(
        JSON.stringify(
          audioMsg({
            attachments: [{ id: 56, file_type: "file", data_url: "https://cw.test/x.pdf" }]
          })
        )
      )
    );
    expect(decision).toMatchObject({ action: "ignore", reason: "empty-content" });
  });

  it("reads audio from the nested AgentBot payload shape", () => {
    const nested = audioMsg({ attachments: undefined });
    (nested.conversation as Record<string, unknown>).messages = [
      {
        id: 900,
        content: "",
        message_type: 0,
        attachments: [
          { id: 57, file_type: "audio", data_url: "https://cw.test/b.ogg", content_type: "audio/ogg" }
        ]
      }
    ];
    const decision = classifyInbound(parseWebhook(JSON.stringify(nested)));
    expect(decision.action).toBe("dispatch");
    expect(decision.audioAttachments?.[0]?.data_url).toBe("https://cw.test/b.ogg");
  });
});
