/**
 * Shared configuration and result types for the Chatwoot channel plugin.
 *
 * These types are intentionally free of any OpenClaw SDK imports so the core
 * logic can be unit tested with plain Vitest + mocks.
 */

export interface ChatwootChannelConfig {
  /** Chatwoot base URL, e.g. https://app.chatwoot.com */
  baseUrl: string;
  /** Chatwoot account id. */
  accountId: string | number;
  /** Chatwoot user API access token (sent as the api_access_token header). */
  apiToken: string;
  /** Shared secret used to authenticate inbound webhooks. */
  webhookSecret?: string;
  /**
   * Secret that signs Chatwoot AgentBot deliveries to this same endpoint.
   * In "chatwoot" signature mode, inbound signatures are validated against
   * `webhookSecret` and this secret; a match against either is accepted, so
   * account webhooks and AgentBot deliveries share one route safely.
   */
  agentBotWebhookSecret?: string;
  /**
   * Inbox ids driven by a Chatwoot AgentBot. On those inboxes the conversation
   * status is the ownership signal: `pending` belongs to the bot (dispatch),
   * `open`/`snoozed` belong to humans (suppress automatic replies). Other
   * inboxes keep the plugin-side handoff state machine.
   */
  botInboxIds?: Array<string | number>;
  /**
   * Signature scheme for inbound webhooks.
   *  - "chatwoot" (default): native `X-Chatwoot-Signature` / `X-Chatwoot-Timestamp`.
   *  - "custom": legacy `HMAC-SHA256(rawBody)` in `webhookHeader`.
   */
  webhookSignatureMode?: "chatwoot" | "custom";
  /** Header carrying the custom HMAC signature (custom mode only). */
  webhookHeader?: string;
  /** Replay window for native signatures, seconds. Default 300; 0 disables. */
  webhookTimestampToleranceSec?: number;
  /** Gateway HTTP path that receives Chatwoot webhooks. Default /chatwoot/webhook. */
  webhookPath?: string;
  /** Team id that human reception is assigned to (Level 1). */
  receptionTeamId?: string | number;
  /** Optional reception team name for diagnostics. */
  receptionTeamName?: string;
  /** Team id for administration (Level 2). Used to validate agent-requested handoffs. */
  administrationTeamId?: string | number;
  /** Optional administration team name for diagnostics. */
  administrationTeamName?: string;
  /** Ordered fallback models tried on quota exhaustion / transient model failure. */
  fallbackModels?: string[];
  /** Customer-facing notice sent on handoff. */
  handoffNotice?: string;
  /** Private note added on handoff. */
  handoffNoteTemplate?: string;
  /** Max retries for transient failures. Default 3. */
  maxRetries?: number;
  /** DM allowlist (optional). */
  allowFrom?: string[];
  /** DM policy (optional). */
  dmSecurity?: string;
  /**
   * Durable inbound queue (spool + background worker). Defaults to true; set
   * false to restore the legacy inline lane dispatch (e.g. quick rollback).
   */
  queueEnabled?: boolean;
}

export interface ChatwootPluginConfig {
  stateDir?: string;
  timeoutMs?: number;
}

export const DEFAULT_WEBHOOK_PATH = "/chatwoot/webhook";
export const DEFAULT_WEBHOOK_HEADER = "x-openclaw-signature";
export const DEFAULT_WEBHOOK_SIGNATURE_MODE = "chatwoot" as const;
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;
export const DEFAULT_HANDOFF_NOTICE =
  "I'm connecting you with a member of our team. A human will continue from here.";
export const DEFAULT_HANDOFF_NOTE =
  "OpenClaw handed this conversation to reception after an unrecoverable automation failure.";
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 15000;

/** Normalize a raw channel config object (from OpenClaw) into a typed config. */
export function normalizeChannelConfig(raw: Record<string, unknown> = {}): ChatwootChannelConfig {
  const baseUrl = String(raw.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("chatwoot: baseUrl is required");
  // Account id may come from the channel config or, as a fallback, the
  // deployment environment (`CHATWOOT_ACCOUNT_ID`). The env var is the single
  // source of truth for which account this deployment serves.
  const accountIdRaw = raw.accountId ?? process.env.CHATWOOT_ACCOUNT_ID;
  if (accountIdRaw === undefined || accountIdRaw === null || accountIdRaw === "") {
    throw new Error(
      "chatwoot: accountId is required (set channels.chatwoot.accountId or CHATWOOT_ACCOUNT_ID)"
    );
  }
  if (!raw.apiToken) throw new Error("chatwoot: apiToken is required");
  const signatureMode =
    raw.webhookSignatureMode === "custom" ? "custom" : DEFAULT_WEBHOOK_SIGNATURE_MODE;
  return {
    baseUrl,
    accountId: accountIdRaw as string | number,
    apiToken: String(raw.apiToken),
    webhookSecret: raw.webhookSecret ? String(raw.webhookSecret) : undefined,
    agentBotWebhookSecret: raw.agentBotWebhookSecret ? String(raw.agentBotWebhookSecret) : undefined,
    botInboxIds: Array.isArray(raw.botInboxIds)
      ? (raw.botInboxIds as unknown[]).map(String)
      : undefined,
    webhookSignatureMode: signatureMode,
    webhookHeader: raw.webhookHeader ? String(raw.webhookHeader) : DEFAULT_WEBHOOK_HEADER,
    webhookTimestampToleranceSec:
      typeof raw.webhookTimestampToleranceSec === "number"
        ? raw.webhookTimestampToleranceSec
        : DEFAULT_WEBHOOK_TOLERANCE_SEC,
    webhookPath: raw.webhookPath ? String(raw.webhookPath) : DEFAULT_WEBHOOK_PATH,
    receptionTeamId: raw.receptionTeamId as string | number | undefined,
    receptionTeamName: raw.receptionTeamName ? String(raw.receptionTeamName) : undefined,
    administrationTeamId: raw.administrationTeamId as string | number | undefined,
    administrationTeamName: raw.administrationTeamName ? String(raw.administrationTeamName) : undefined,
    fallbackModels: Array.isArray(raw.fallbackModels)
      ? (raw.fallbackModels as unknown[]).map(String)
      : undefined,
    handoffNotice: raw.handoffNotice ? String(raw.handoffNotice) : DEFAULT_HANDOFF_NOTICE,
    handoffNoteTemplate: raw.handoffNoteTemplate ? String(raw.handoffNoteTemplate) : DEFAULT_HANDOFF_NOTE,
    maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : DEFAULT_MAX_RETRIES,
    allowFrom: Array.isArray(raw.allowFrom) ? (raw.allowFrom as unknown[]).map(String) : undefined,
    dmSecurity: raw.dmSecurity ? String(raw.dmSecurity) : undefined,
    queueEnabled: raw.queueEnabled === false ? false : true
  };
}
