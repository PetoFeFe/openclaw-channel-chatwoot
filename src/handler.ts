import { classifyError, type FailureInfo } from "./failure.js";
import { ChatwootApiError } from "./client.js";
import { decideFallback } from "./fallback.js";
import {
  performHandoff,
  resumeHandoff,
  type HandoffClient,
  type Logger
} from "./handoff.js";
import { normalizeAgentResult, type AgentOutcome } from "./model.js";
import { conversationKey, sessionKey } from "./routing.js";
import type { DurableState } from "./state.js";
import type { ChatwootChannelConfig } from "./types.js";
import {
  classifyInbound,
  parseWebhook,
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
  model?: string;
  raw: ChatwootWebhookMessage;
}

export type Dispatch = (
  request: DispatchRequest
) => Promise<AgentOutcome | unknown> | AgentOutcome | unknown;

export interface WebhookHandlerDeps {
  config: ChatwootChannelConfig;
  state: DurableState;
  client: HandoffClient;
  dispatch: Dispatch;
  /** Value of the configured signature header (if present). */
  signatureHeader?: string;
  log?: Logger;
  now?: () => Date;
  onOperatorAlert?: (info: { class: string; detail: string; convKey?: string }) => void;
}

export interface WebhookHandlerResult {
  status: number;
  action: string;
  reason?: string;
}

export async function handleWebhookEvent(
  rawBody: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult> {
  const { config, state, client } = deps;
  const log = deps.log ?? {};
  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();

  // 1. Authenticate.
  if (
    !verifyWebhookSignature({
      rawBody,
      secret: config.webhookSecret,
      headerValue: deps.signatureHeader
    })
  ) {
    log.warn?.("chatwoot: rejected webhook with invalid signature");
    return { status: 401, action: "rejected", reason: "bad-signature" };
  }

  // 2. Parse.
  let event;
  try {
    event = parseWebhook(rawBody);
  } catch (error) {
    log.warn?.("chatwoot: malformed webhook payload", { error: (error as Error).message });
    return { status: 400, action: "rejected", reason: "malformed" };
  }

  // 3. Filter outgoing/private/self messages.
  const decision = classifyInbound(event, config);
  if (decision.action === "ignore") {
    return { status: 200, action: "ignored", reason: decision.reason };
  }

  const accountId = decision.accountId || String(config.accountId);
  const conversationId = decision.conversationId as string;
  const convKey = conversationKey(accountId, conversationId);

  // 4. Deduplicate by Chatwoot message id (persist before dispatch so a
  //    concurrent webhook or a restart cannot process the same message twice).
  if (decision.messageId !== undefined) {
    const msgKey = `msg:${accountId}:${decision.messageId}`;
    if (state.isProcessed(msgKey)) {
      return { status: 200, action: "duplicate", reason: "already-processed" };
    }
    await state.markProcessed(msgKey, nowIso());
  }

  // 5. Suppress automatic replies while a human owns the conversation.
  if (state.isHandoffActive(convKey)) {
    return { status: 200, action: "suppressed-handoff", reason: "human-handoff-active" };
  }

  // 6. Run the agent, applying retry / fallback-model / handoff policy.
  const raw = event as ChatwootWebhookMessage;
  const result = await runAgentWithPolicy(
    {
      accountId,
      conversationId,
      sessionKey: sessionKey(accountId, conversationId),
      text: decision.text as string,
      messageId: decision.messageId,
      senderId: decision.senderId,
      raw
    },
    convKey,
    deps
  );
  return result;
}

async function runAgentWithPolicy(
  request: DispatchRequest,
  convKey: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult> {
  const { config, state, client } = deps;
  const log = deps.log ?? {};
  const now = deps.now ?? (() => new Date());
  const fallbacks = config.fallbackModels ?? [];
  const maxRetries = config.maxRetries ?? 3;

  const tried: string[] = [];
  let model: string | undefined;
  let transientLeft = maxRetries;
  const guard = maxRetries + fallbacks.length + 3;

  for (let attempt = 0; attempt < guard; attempt += 1) {
    let outcome: AgentOutcome;
    try {
      outcome = normalizeAgentResult(await deps.dispatch({ ...request, model }));
    } catch (error) {
      outcome = { ok: false, error };
    }

    if (outcome.ok) {
      log.info?.("chatwoot: agent reply delivered", {
        convKey,
        model: outcome.model ?? model,
        messageId: outcome.deliveredMessageId
      });
      return { status: 200, action: model ? "dispatched-fallback" : "dispatched" };
    }

    const info = resolveFailure(outcome);
    log.warn?.("chatwoot: agent run failed", {
      convKey,
      class: info.class,
      status: info.status,
      detail: info.operatorDetail
    });

    if (info.class === "transient" && transientLeft > 0) {
      transientLeft -= 1;
      continue;
    }
    if (info.class === "transient" && tried.length === 0) {
      // No transient retries left; make the fallback decision treat this model
      // as already attempted.
      tried.push(model ?? "__default__");
    }

    const decision = decideFallback(info, config, { tried, currentModel: model });
    if (decision.action === "fallback" && decision.model) {
      tried.push(model ?? "__default__");
      model = decision.model;
      log.info?.("chatwoot: falling back to model", { convKey, model });
      continue;
    }
    if (decision.action === "alert") {
      // Never expose provider/config errors to the customer.
      deps.onOperatorAlert?.({
        class: info.class,
        detail: info.operatorDetail,
        convKey
      });
      log.error?.("chatwoot: operator action required", { convKey, detail: info.operatorDetail });
      return { status: 200, action: "alerted", reason: info.class };
    }

    // Handoff to reception.
    await performHandoff({
      client,
      state,
      config,
      conversationId: request.conversationId,
      convKey,
      reason: info.class,
      suppressCustomerNotice: outcome.deliveredTerminalError === true,
      log,
      now: () => now().toISOString()
    });
    return { status: 200, action: "handoff", reason: info.class };
  }

  await performHandoff({
    client,
    state,
    config,
    conversationId: request.conversationId,
    convKey,
    reason: "retry-exhausted",
    log,
    now: () => now().toISOString()
  });
  return { status: 200, action: "handoff", reason: "retry-exhausted" };
}

function resolveFailure(outcome: AgentOutcome): FailureInfo {
  const source = outcome.error instanceof ChatwootApiError ? "chatwoot" : "agent";
  const info = classifyError(outcome.error, source);
  if (outcome.quotaExhausted && info.class !== "quota") {
    return { ...info, class: "quota", retryable: false };
  }
  return info;
}

/**
 * Handle conversation lifecycle events to implement explicit, verified resume:
 * reception returning the conversation to the bot (team reassigned away from
 * reception, or conversation resolved) re-enables automatic replies.
 */
export async function handleConversationEvent(
  rawBody: string,
  deps: WebhookHandlerDeps
): Promise<WebhookHandlerResult> {
  const { config, state } = deps;
  const log = deps.log ?? {};
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  if (
    !verifyWebhookSignature({
      rawBody,
      secret: config.webhookSecret,
      headerValue: deps.signatureHeader
    })
  ) {
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

  const inner = event.conversation ?? event;
  const conversationId = inner.id;
  if (conversationId === undefined || conversationId === null) {
    return { status: 200, action: "ignored", reason: "missing-conversation" };
  }
  const accountId = String(event.account?.id ?? config.accountId);
  const convKey = conversationKey(accountId, String(conversationId));

  if (!state.isHandoffActive(convKey)) {
    return { status: 200, action: "ignored", reason: "no-active-handoff" };
  }

  if (!isResumeSignal(inner.team_id, inner.status, config)) {
    return { status: 200, action: "ignored", reason: "handoff-still-active" };
  }

  await resumeHandoff(state, convKey, now);
  log.info?.("chatwoot: handoff resumed; automatic replies re-enabled", { convKey });
  return { status: 200, action: "resumed" };
}

function isResumeSignal(
  teamId: number | null | undefined,
  status: string | undefined,
  config: ChatwootChannelConfig
): boolean {
  // Reception returns the conversation to the bot by reassigning the team.
  if (teamId !== undefined && teamId !== null && config.receptionTeamId !== undefined) {
    if (String(teamId) !== String(config.receptionTeamId)) return true;
  }
  if (teamId === null && config.receptionTeamId !== undefined) {
    // Team cleared entirely: treat as returned to the bot.
    return true;
  }
  if (status === "resolved") return true;
  return false;
}

/**
 * Startup recovery: finish any handoff whose side effects were interrupted by a
 * restart. Idempotent (markers + recorded status prevent duplicate notes/notices).
 */
export async function recoverPendingEffects(deps: {
  state: DurableState;
  client: HandoffClient;
  config: ChatwootChannelConfig;
  log?: Logger;
}): Promise<number> {
  const { state, client, config, log } = deps;
  let recovered = 0;
  // Enumerate conversations known to the state store that still have pending effects.
  for (const convKey of state.pendingConversationKeys()) {
    if (state.listEffects(convKey).some((effect) => effect.status === "pending")) {
      const parts = convKey.split(":");
      const conversationId = parts[parts.length - 1];
      await performHandoff({
        client,
        state,
        config,
        conversationId,
        convKey,
        reason: "restart-recovery",
        log
      });
      recovered += 1;
    }
  }
  return recovered;
}
