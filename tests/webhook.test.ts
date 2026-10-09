import { describe, expect, it } from "vitest";
import {
  classifyInbound,
  parseWebhook,
  signChatwootPayload,
  signWebhookBody,
  verifyChatwootSignature,
  verifyWebhookSignature
} from "../src/webhook.js";
import { makeMessageEvent } from "./helpers.js";

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

  it("tolerates numeric strings for message and conversation ids", () => {
    const event = makeMessageEvent({ conversationId: 5, messageId: 9 });
    event.id = "9";
    (event.conversation as { id: number | string }).id = "5";
    const decision = classifyInbound(parseWebhook(JSON.stringify(event)));
    expect(decision).toMatchObject({ action: "dispatch", conversationId: "5", messageId: 9 });
  });
});
