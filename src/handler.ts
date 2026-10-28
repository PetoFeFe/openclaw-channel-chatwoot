import { sessionKey } from "./routing.js";
import type { DurableState } from "./state.js";
import {
  DEFAULT_PROMPT_FALLBACK_VALUE,
  DEFAULT_PROMPT_TEMPLATE,
  type ChatwootChannelConfig
} from "./types.js";
import {
  classifyInbound,
  extractContactInfo,
  extractInboxType,
  parseWebhook,
  verifyChatwootSignature,
  verifyWebhookSignature,
  type ChatwootContactInfo,
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
  inboxId?: string;
  inboxName?: string;
  inboxType?: string;
  /** Normalized contact details extracted from the webhook payload. */
  contact?: ChatwootContactInfo;
  /** Voice-note/audio attachments to stage for transcription (may be empty). */
  audioAttachments?: ChatwootWebhookAttachment[];
  raw: ChatwootWebhookMessage;
}

export interface FormatInboundPromptOptions {
  /** Custom template string with `{placeholder}` or `{placeholder|fallback}` tokens. */
  promptTemplate?: string;
  /** Default replacement when a placeholder is empty and has no inline `|fallback`. */
  promptFallbackValue?: string;
  /** Override for `{text}` (e.g. "(mensagem de voz recebida)" for voice notes). */
  textOverride?: string;
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolvePromptVariable(
  key: string,
  request: DispatchRequest,
  contact: ChatwootContactInfo,
  textValue: string
): unknown {
  switch (key) {
    case "conversationId":
    case "conversation.id":
      return request.conversationId;
    case "accountId":
    case "account.id":
      return request.accountId;
    case "status":
    case "conversation.status":
      return request.status ?? "unknown";
    case "text":
    case "content":
      return textValue;
    case "messageId":
    case "id":
      return request.messageId;
    case "senderId":
      return request.senderId ?? contact.id;
    case "inboxId":
    case "inbox.id":
      return request.inboxId ?? request.raw?.inbox?.id ?? request.raw?.conversation?.inbox_id;
    case "inboxName":
    case "inbox.name":
      return (
        request.inboxName ??
        request.raw?.inbox?.name ??
        getNestedValue(request.raw, "conversation.inbox.name") ??
        getNestedValue(request.raw, "conversation.meta.inbox.name")
      );
    case "inboxType":
    case "inbox.type":
    case "inbox.channel_type":
    case "channelType":
      return request.inboxType ?? (request.raw ? extractInboxType(request.raw) : undefined);
  }

  if (key.startsWith("contact.")) {
    const subKey = key.slice("contact.".length);
    switch (subKey) {
      case "id":
        return contact.id ?? request.senderId;
      case "name":
        return contact.name;
      case "email":
        return contact.email;
      case "phone":
      case "phone_number":
        return contact.phone;
      case "identifier":
        return contact.identifier;
    }
    if (subKey.startsWith("custom_attributes.")) {
      return getNestedValue(contact.customAttributes, subKey.slice("custom_attributes.".length));
    }
    if (subKey.startsWith("customAttributes.")) {
      return getNestedValue(contact.customAttributes, subKey.slice("customAttributes.".length));
    }
    if (subKey.startsWith("additional_attributes.")) {
      return getNestedValue(
        contact.additionalAttributes,
        subKey.slice("additional_attributes.".length)
      );
    }
    if (subKey.startsWith("additionalAttributes.")) {
      return getNestedValue(
        contact.additionalAttributes,
        subKey.slice("additionalAttributes.".length)
      );
    }
    return (
      getNestedValue(request.raw?.sender, subKey) ??
      getNestedValue(request.raw?.conversation?.meta?.sender, subKey) ??
      getNestedValue(contact.customAttributes, subKey) ??
      getNestedValue(contact.additionalAttributes, subKey)
    );
  }

  return getNestedValue(request.raw, key);
}

/**
 * Format the inbound message prompt sent to the OpenClaw agent using the
 * configured template and fallback value for missing contact/conversation fields.
 */
export function formatInboundPrompt(
  request: DispatchRequest,
  options?: FormatInboundPromptOptions
): string {
  const template =
    options?.promptTemplate && options.promptTemplate.trim().length > 0
      ? options.promptTemplate
      : DEFAULT_PROMPT_TEMPLATE;
  const defaultFallback = options?.promptFallbackValue ?? DEFAULT_PROMPT_FALLBACK_VALUE;
  const textValue = options?.textOverride !== undefined ? options.textOverride : request.text;
  const contact = request.contact ?? (request.raw ? extractContactInfo(request.raw) : {});

  return template.replace(/\{([a-zA-Z0-9_.-]+)(?:\|([^}]*))?\}/g, (_match, rawKey: string, inlineFallback?: string) => {
    const fallback = inlineFallback !== undefined ? inlineFallback : defaultFallback;
    const value = resolvePromptVariable(rawKey, request, contact, textValue);
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === "string") {
      if (rawKey === "text" || rawKey === "content") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  });
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
    inboxId: decision.inboxId,
    inboxName: decision.inboxName,
    inboxType: decision.inboxType,
    contact: decision.contact,
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
