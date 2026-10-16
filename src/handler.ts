import { conversationKey, sessionKey } from "./routing.js";
import type { DurableState } from "./state.js";
import type { ChatwootChannelConfig } from "./types.js";
import {
  classifyInbound,
  isAccountAllowed,
  parseWebhook,
  verifyChatwootSignature,
  verifyWebhookSignature,
  type ChatwootWebhookConversation,
  type ChatwootWebhookMessage
} from "./webhook.js";

export interface DispatchRequest {
  accountId: string;
  conversationId: string;
  sessionKey: string;
  text: string;
  messageId?: number;
  senderId?: string;
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
    timestampHeader: deps.timestampHeader,
    signatureHeader: deps.signatureHeader,
    toleranceSec: config.webhookTimestampToleranceSec,
    nowMs: deps.now ? deps.now().getTime() : undefined
  });
}

/**
 * Validates, authenticates, and deduplicates the incoming webhook.
 * Returns the HTTP response acknowledgment and the validated request.
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

  // 3. Filter outgoing/private/self messages & verify accountId.
  const decision = classifyInbound(event, config);
  if (decision.action === "ignore") {
    return { status: 200, action: "ignored", reason: decision.reason };
  }

  const accountId = decision.accountId || String(config.accountId);
  const conversationId = decision.conversationId as string;
  const convKey = conversationKey(accountId, conversationId);

  // 4. Deduplicate by Chatwoot message id.
  if (decision.messageId !== undefined) {
    const msgKey = `msg:${accountId}:${decision.messageId}`;
    const claimed = await state.claimProcessed(msgKey, nowIso());
    if (!claimed) {
      return { status: 200, action: "duplicate", reason: "already-processed" };
    }
  }

  // 5. Suppress automatic replies while a human owns the conversation.
  if (state.isHandoffActive(convKey)) {
    return { status: 200, action: "suppressed-handoff", reason: "human-handoff-active" };
  }

  const raw = event as ChatwootWebhookMessage;
  const request: DispatchRequest = {
    accountId,
    conversationId,
    sessionKey: sessionKey(accountId, conversationId),
    text: decision.text as string,
    messageId: decision.messageId,
    senderId: decision.senderId,
    raw
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

/**
 * Handle conversation lifecycle events (e.g. status changed to resolved).
 */
export async function handleConversationEvent(
  rawBody: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult> {
  const { config, state } = deps;
  const log = deps.log ?? {};
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  if (!verifyInbound(rawBody, deps)) {
    return { status: 401, action: "rejected", reason: "bad-signature" };
  }

  let event: ChatwootWebhookConversation;
  try {
    event = parseWebhook(rawBody) as ChatwootWebhookConversation;
  } catch {
    return { status: 400, action: "rejected", reason: "malformed" };
  }

  if (
    event.event !== "conversation_updated" &&
    event.event !== "conversation_status_changed" &&
    event.event !== "conversation_created"
  ) {
    return { status: 200, action: "ignored", reason: "event-not-conversation" };
  }

  if (!isAccountAllowed(event, config)) {
    return { status: 200, action: "ignored", reason: "account-mismatch" };
  }

  const inner = event.conversation ?? event;
  const conversationId = inner.id;
  if (conversationId === undefined || conversationId === null) {
    return { status: 200, action: "ignored", reason: "conversation-id-missing" };
  }

  const accountId = String(event.account?.id ?? config.accountId);
  const convKey = conversationKey(accountId, conversationId);

  if (!state.isHandoffActive(convKey)) {
    return { status: 200, action: "ignored", reason: "no-active-handoff" };
  }

  if (isResumeSignal(inner.team_id, inner.status, config)) {
    await state.setHandoff(convKey, { active: false, updatedAt: now() });
    log.info?.("chatwoot: handoff resumed; automatic replies re-enabled", { convKey });
    return { status: 200, action: "resumed" };
  }

  return { status: 200, action: "ignored", reason: "handoff-still-active" };
}

function isResumeSignal(
  teamId: string | number | null | undefined,
  status: string | undefined,
  config: ChatwootChannelConfig
): boolean {
  if (status === "resolved") return true;
  if (teamId === null && config.receptionTeamId !== undefined) return true;
  return false;
}
