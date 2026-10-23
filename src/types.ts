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
  /**
   * Chatwoot user API access token. Used only to download private inbound
   * attachments (voice notes/images) into the OpenClaw media store.
   */
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
  /** DM allowlist (optional). */
  allowFrom?: string[];
  /** DM policy (optional). */
  dmSecurity?: string;
}

export interface ChatwootPluginConfig {
  stateDir?: string;
}

export const DEFAULT_WEBHOOK_PATH = "/chatwoot/webhook";
export const DEFAULT_WEBHOOK_HEADER = "x-openclaw-signature";
export const DEFAULT_WEBHOOK_SIGNATURE_MODE = "chatwoot" as const;
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

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
    webhookSignatureMode: signatureMode,
    webhookHeader: raw.webhookHeader ? String(raw.webhookHeader) : DEFAULT_WEBHOOK_HEADER,
    webhookTimestampToleranceSec:
      typeof raw.webhookTimestampToleranceSec === "number"
        ? raw.webhookTimestampToleranceSec
        : DEFAULT_WEBHOOK_TOLERANCE_SEC,
    webhookPath: raw.webhookPath ? String(raw.webhookPath) : DEFAULT_WEBHOOK_PATH,
    allowFrom: Array.isArray(raw.allowFrom) ? (raw.allowFrom as unknown[]).map(String) : undefined,
    dmSecurity: raw.dmSecurity ? String(raw.dmSecurity) : undefined
  };
}
