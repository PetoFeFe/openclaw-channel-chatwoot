import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatwootChannelConfig } from "./types.js";

/**
 * Chatwoot webhook parsing, authentication, and inbound filtering.
 *
 * Chatwoot does not natively sign webhooks, so inbound authentication is done
 * with a shared-secret HMAC-SHA256 over the raw request body, carried in a
 * configurable header. Static bearer tokens are also accepted.
 */

export interface ChatwootWebhookMessage extends Record<string, unknown> {
  event: "message_created";
  id: number;
  content?: string;
  message_type?: "incoming" | "outgoing" | "template";
  private?: boolean;
  content_type?: string;
  conversation?: {
    id?: number;
    status?: string;
    team_id?: number | null;
    inbox_id?: number;
    [key: string]: unknown;
  };
  account?: { id?: number; [key: string]: unknown };
  sender?: { id?: number; type?: string; [key: string]: unknown };
}

export interface ChatwootWebhookConversation extends Record<string, unknown> {
  event: "conversation_updated" | "conversation_status_changed" | "conversation_created";
  id?: number;
  status?: string;
  team_id?: number | null;
  conversation?: {
    id?: number;
    status?: string;
    team_id?: number | null;
    [key: string]: unknown;
  };
  account?: { id?: number; [key: string]: unknown };
}

export type ChatwootWebhookEvent = ChatwootWebhookMessage | ChatwootWebhookConversation;

export type InboundAction = "dispatch" | "ignore";

export interface InboundDecision {
  action: InboundAction;
  reason: string;
  accountId?: string;
  conversationId?: string;
  messageId?: number;
  text?: string;
  senderId?: string;
  senderType?: string;
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Compute the hex HMAC-SHA256 signature of a raw body. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(params: {
  rawBody: string;
  secret?: string;
  headerValue?: string;
}): boolean {
  const { rawBody, secret, headerValue } = params;
  // No secret configured => webhook auth is disabled (not recommended).
  if (!secret) return true;
  if (!headerValue) return false;
  const provided = headerValue.startsWith("sha256=")
    ? headerValue.slice("sha256=".length)
    : headerValue;
  const expected = signWebhookBody(rawBody, secret);
  return safeEqual(provided.trim().toLowerCase(), expected);
}

export function parseWebhook(rawBody: string): ChatwootWebhookEvent {
  const parsed = JSON.parse(rawBody) as ChatwootWebhookEvent;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { event?: unknown }).event !== "string") {
    throw new Error("chatwoot: webhook payload missing event");
  }
  return parsed;
}

/**
 * Decide whether an event should be dispatched to the agent.
 *
 * Outgoing agent/bot messages and private notes are filtered out to prevent
 * reply loops. Only customer-initiated incoming messages are dispatched.
 */
export function classifyInbound(
  event: ChatwootWebhookEvent,
  _config?: ChatwootChannelConfig
): InboundDecision {
  if (event.event !== "message_created") {
    return { action: "ignore", reason: "event-not-message" };
  }
  const msg = event as ChatwootWebhookMessage;
  if (msg.message_type !== "incoming") {
    return { action: "ignore", reason: "not-incoming" };
  }
  if (msg.private === true) {
    return { action: "ignore", reason: "private" };
  }
  const senderType = typeof msg.sender?.type === "string" ? msg.sender.type : undefined;
  if (senderType === "agent" || senderType === "bot") {
    return { action: "ignore", reason: "self-authored" };
  }
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!text) {
    return { action: "ignore", reason: "empty-content" };
  }
  const conversationId = msg.conversation?.id;
  if (conversationId === undefined || conversationId === null) {
    return { action: "ignore", reason: "missing-conversation" };
  }
  return {
    action: "dispatch",
    reason: "incoming",
    accountId: String(msg.account?.id ?? ""),
    conversationId: String(conversationId),
    messageId: typeof msg.id === "number" ? msg.id : undefined,
    text,
    senderId: msg.sender?.id !== undefined ? String(msg.sender.id) : undefined,
    senderType
  };
}
