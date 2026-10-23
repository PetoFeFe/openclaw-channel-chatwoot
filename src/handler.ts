import { sessionKey } from "./routing.js";
import type { DurableState } from "./state.js";
import type { ChatwootChannelConfig } from "./types.js";
import {
  classifyInbound,
  parseWebhook,
  verifyChatwootSignature,
  verifyWebhookSignature,
  type ChatwootWebhookAttachment,
  type ChatwootWebhookMessage
} from "./webhook.js";

export interface DispatchRequest {
  accountId: string;
  conversationId: string;
  sessionKey: string;
  text: string;
  messageId?: number;
  /** Conversation status at receipt; forwarded to the agent as context. */
  status?: string;
  senderId?: string;
  /** Voice-note/audio attachments to stage for transcription (may be empty). */
  audioAttachments?: ChatwootWebhookAttachment[];
  raw: ChatwootWebhookMessage;
}

export type Dispatch = (request: DispatchRequest) => Promise<unknown> | unknown;

export interface WebhookHandlerDeps {
  config: ChatwootChannelConfig;
  state: DurableState;
  dispatch: Dispatch;
  signatureHeader?: string;
  timestampHeader?: string;
  deliveryId?: string;
  log?: {
    info?: (msg: string, ctx?: Record<string, unknown>) => void;
    warn?: (msg: string, ctx?: Record<string, unknown>) => void;
    error?: (msg: string, ctx?: Record<string, unknown>) => void;
  };
  now?: () => Date;
}

export interface WebhookHandlerResult {
  status: number;
  action: string;
  reason?: string;
}

/** Verify an inbound webhook using the configured signature mode. */
function verifyInbound(rawBody: string, deps: WebhookHandlerDeps): boolean {
  const { config } = deps;
  if ((config.webhookSignatureMode ?? "chatwoot") === "custom") {
    return verifyWebhookSignature({
      rawBody,
      secret: config.webhookSecret,
      headerValue: deps.signatureHeader
    });
  }
  return verifyChatwootSignature({
    rawBody,
    secret: config.webhookSecret,
    additionalSecrets: [config.agentBotWebhookSecret],
    timestampHeader: deps.timestampHeader,
    signatureHeader: deps.signatureHeader,
    toleranceSec: config.webhookTimestampToleranceSec,
    nowMs: deps.now ? deps.now().getTime() : undefined
  });
}

/**
 * Authenticate, validate, and deduplicate an inbound webhook. Returns the HTTP
 * acknowledgment and, for a dispatchable customer message, the request to hand
 * to the agent.
 *
 * Deduplication happens before dispatch. Once a message id is claimed it stays
 * claimed even when the agent submission fails: the plugin never retries and
 * never generates a second turn for the same Chatwoot message.
 */
export async function prepareInboundAck(
  rawBody: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult & { request?: DispatchRequest }> {
  const { config, state } = deps;
  const log = deps.log ?? {};
  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();

  // 1. Authenticate.
  if (!verifyInbound(rawBody, deps)) {
    log.warn?.("chatwoot: rejected webhook with invalid signature");
    return { status: 401, action: "rejected", reason: "bad-signature" };
  }

  // 1b. Delivery-id replay dedupe.
  if (deps.deliveryId) {
    const ok = await state.claimProcessed(`delivery:${deps.deliveryId}`, nowIso());
    if (!ok) return { status: 200, action: "duplicate", reason: "delivery-replayed" };
  }

  // 2. Parse payload.
  let event;
  try {
    event = parseWebhook(rawBody);
  } catch (error) {
    log.warn?.("chatwoot: malformed webhook payload", { error: (error as Error).message });
    return { status: 400, action: "rejected", reason: "malformed" };
  }

  // 3. Filter outgoing/private/self messages and non-message events.
  const decision = classifyInbound(event, config);
  if (decision.action === "ignore") {
    return { status: 200, action: "ignored", reason: decision.reason };
  }

  const accountId = decision.accountId || String(config.accountId);
  const conversationId = decision.conversationId as string;

  // 4. Deduplicate by Chatwoot message id before any agent work.
  const msgKey =
    decision.messageId !== undefined ? `msg:${accountId}:${decision.messageId}` : undefined;
  if (msgKey) {
    const claimed = await state.claimProcessed(msgKey, nowIso());
    if (!claimed) {
      return { status: 200, action: "duplicate", reason: "already-processed" };
    }
  }

  const request: DispatchRequest = {
    accountId,
    conversationId,
    sessionKey: sessionKey(accountId, conversationId),
    text: decision.text as string,
    messageId: decision.messageId,
    senderId: decision.senderId,
    status: decision.conversationStatus,
    audioAttachments: decision.audioAttachments,
    raw: event as ChatwootWebhookMessage
  };

  return { status: 200, action: "dispatched", request };
}

export async function handleWebhookEvent(
  rawBody: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult> {
  const ack = await prepareInboundAck(rawBody, deps);
  if (ack.action === "dispatched" && ack.request) {
    await deps.dispatch(ack.request);
  }
  return { status: ack.status, action: ack.action, reason: ack.reason };
}
