import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatwootChannelConfig } from "./types.js";

/**
 * Chatwoot webhook parsing, authentication, and inbound filtering.
 *
 * Authentication has two modes:
 *  - "chatwoot" (default): native signing. Chatwoot sends
 *      X-Chatwoot-Timestamp: <unix seconds>
 *      X-Chatwoot-Signature: sha256=<hex HMAC-SHA256(secret, "{timestamp}.{raw_body}")>
 *      X-Chatwoot-Delivery:  <delivery id, optional>
 *    Both account webhooks and AgentBot deliveries use this scheme, each with
 *    its own secret. When `botWebhookSecret` is configured, a signature that
 *    validates against either secret is accepted (same endpoint serves both).
 *  - "custom": a shared-secret HMAC-SHA256 over the raw body, carried in a
 *    configurable header (for deployments behind a signing proxy).
 *
 * A static bearer token is never accepted: it cannot be replayed-protected.
 */

export interface ChatwootWebhookMessage extends Record<string, unknown> {
  event: "message_created" | "message_updated";
  id: number | string;
  content?: string;
  /** String enum (account webhooks) or raw integer (message push data: 0/1/2). */
  message_type?: "incoming" | "outgoing" | "template" | number;
  private?: boolean;
  content_type?: string;
  conversation_id?: number | string;
  conversation?: {
    id?: number | string;
    status?: string;
    team_id?: number | string | null;
    inbox_id?: number | string;
    messages?: Array<{ id?: number | string; content?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  inbox?: { id?: number | string; name?: string; [key: string]: unknown };
  account?: { id?: number | string; [key: string]: unknown };
  sender?: { id?: number | string; type?: string; [key: string]: unknown };
}

export interface ChatwootWebhookConversation extends Record<string, unknown> {
  event: "conversation_updated" | "conversation_status_changed" | "conversation_created";
  /** Real Chatwoot conversation events are flat: id/status/team_id at the top level. */
  id?: number | string;
  status?: string;
  team_id?: number | string | null;
  changed_attributes?: Record<string, unknown>;
  conversation?: {
    id?: number | string;
    status?: string;
    team_id?: number | string | null;
    [key: string]: unknown;
  };
  account?: { id?: number | string; [key: string]: unknown };
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
  /** Conversation status carried by the webhook payload, when present. */
  conversationStatus?: string;
  /** Inbox id from the payload, when present (AgentBot payloads include it). */
  inboxId?: string;
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Compute the hex HMAC-SHA256 signature of a raw body (custom mode). */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Legacy/custom mode: HMAC-SHA256 over the raw body, hex, optionally prefixed
 * with "sha256=".
 */
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

/** Native Chatwoot signature: `sha256=` + HMAC-SHA256(secret, "{timestamp}.{body}"). */
export function signChatwootPayload(
  rawBody: string,
  timestamp: string,
  secret: string
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex")}`;
}

/**
 * Verify a native Chatwoot signed webhook.
 *
 * Returns true when no secret is configured (auth explicitly disabled), or when
 * the signature matches and the timestamp is inside the replay window.
 */
export function verifyChatwootSignature(params: {
  rawBody: string;
  secret?: string;
  /**
   * Additional accepted secrets. Chatwoot AgentBot deliveries are signed with
   * the bot's own secret, while account webhooks use the webhook secret; a
   * single endpoint accepts either when both are configured.
   */
  additionalSecrets?: Array<string | undefined>;
  signatureHeader?: string;
  timestampHeader?: string;
  toleranceSec?: number;
  /** Current time in milliseconds. Injectable for deterministic tests. */
  nowMs?: number;
}): boolean {
  const { rawBody, secret, signatureHeader, timestampHeader } = params;
  const candidates = [secret, ...(params.additionalSecrets ?? [])].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  // No secret configured => webhook auth is disabled (not recommended).
  if (candidates.length === 0) return true;
  if (!signatureHeader || !timestampHeader) return false;

  const tolerance = params.toleranceSec ?? 300;
  if (tolerance > 0) {
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return false;
    const nowSec = (params.nowMs ?? Date.now()) / 1000;
    if (Math.abs(nowSec - timestamp) > tolerance) return false;
  }

  const provided = signatureHeader.trim().toLowerCase();
  return candidates.some((candidate) =>
    safeEqual(provided, signChatwootPayload(rawBody, timestampHeader, candidate))
  );
}

export function parseWebhook(rawBody: string): ChatwootWebhookEvent {
  const parsed = JSON.parse(rawBody) as ChatwootWebhookEvent;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { event?: unknown }).event !== "string"
  ) {
    throw new Error("chatwoot: webhook payload missing event");
  }
  return parsed;
}

/**
 * Account scope: only the configured Chatwoot account is handled.
 *
 * Returns true when the event carries no account id or when it matches
 * `config.accountId`. This makes the deployment env/config the single source of
 * truth for which account is served, so webhooks from any other account are
 * ignored instead of being dispatched to the agent.
 */
export function isAccountAllowed(
  event: { account?: { id?: number | string; [key: string]: unknown } },
  config?: ChatwootChannelConfig
): boolean {
  if (!config || config.accountId === undefined || config.accountId === null) return true;
  const payloadAccountId = event.account?.id;
  if (payloadAccountId === undefined || payloadAccountId === null) return true;
  return String(payloadAccountId) === String(config.accountId);
}

function numericId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function idString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/**
 * Chatwoot `message_type` arrives as the string enum ("incoming"/"outgoing")
 * on message webhooks, but nested/push payloads may carry the raw integer
 * (0 = incoming, 1 = outgoing, 2 = activity). Accept both.
 */
export function isIncomingMessageType(value: unknown): boolean {
  if (value === "incoming") return true;
  if (typeof value === "number") return value === 0;
  return false;
}

/**
 * Message text: flat top-level `content` (message webhook) or, for payloads
 * that nest the triggering message under `conversation.messages`, the nested
 * content. Chatwoot sends both; this is a fallback, not a second source.
 */
function messageTextOf(msg: ChatwootWebhookMessage): string {
  if (typeof msg.content === "string" && msg.content.trim().length > 0) {
    return msg.content.trim();
  }
  const nested = msg.conversation?.messages;
  if (Array.isArray(nested) && nested.length > 0) {
    const first = nested[0];
    if (typeof first?.content === "string") return first.content.trim();
  }
  return "";
}

/**
 * Decide whether an event should be dispatched to the agent.
 *
 * Outgoing agent/bot messages and private notes are filtered out to prevent
 * reply loops. Only customer-initiated incoming messages are dispatched.
 * `message_updated` is handled like `message_created`; dedupe by message id
 * prevents an edited message from being answered twice.
 */
export function classifyInbound(
  event: ChatwootWebhookEvent,
  config?: ChatwootChannelConfig
): InboundDecision {
  if (event.event !== "message_created" && event.event !== "message_updated") {
    return { action: "ignore", reason: "event-not-message" };
  }
  // Account scope: ignore events for any account other than the configured one.
  if (!isAccountAllowed(event, config)) {
    return { action: "ignore", reason: "account-mismatch" };
  }
  const msg = event as ChatwootWebhookMessage;
  if (!isIncomingMessageType(msg.message_type)) {
    return { action: "ignore", reason: "not-incoming" };
  }
  if (msg.private === true) {
    return { action: "ignore", reason: "private" };
  }
  const senderType = typeof msg.sender?.type === "string" ? msg.sender.type : undefined;
  if (senderType === "agent" || senderType === "bot") {
    return { action: "ignore", reason: "self-authored" };
  }
  const text = messageTextOf(msg);
  if (!text) {
    return { action: "ignore", reason: "empty-content" };
  }
  const conversationId = idString(msg.conversation_id) ?? idString(msg.conversation?.id);
  if (conversationId === undefined) {
    return { action: "ignore", reason: "missing-conversation" };
  }
  const status = typeof msg.conversation?.status === "string" ? msg.conversation.status : undefined;
  const inboxId = idString(msg.inbox?.id ?? msg.conversation?.inbox_id);
  // The configured account is authoritative for the session key; fall back to
  // the payload (or empty) only when config does not pin an account.
  const scopedAccountId =
    config && config.accountId !== undefined && config.accountId !== null
      ? String(config.accountId)
      : idString(msg.account?.id) ?? "";
  // Conversation status is NOT an ingress filter: ownership decisions
  // (human takeover on AgentBot inboxes) belong to the agent, which receives
  // the status in its inbound prompt. The plugin always dispatches valid
  // incoming customer messages.
  return {
    action: "dispatch",
    reason: "incoming",
    accountId: scopedAccountId,
    conversationId,
    messageId: numericId(msg.id),
    text,
    senderId: idString(msg.sender?.id),
    senderType,
    conversationStatus: status,
    inboxId
  };
}
