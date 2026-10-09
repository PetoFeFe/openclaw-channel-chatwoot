/**
 * Normalization of an OpenClaw agent-run outcome into a channel-owned shape.
 *
 * The exact runtime result shape is version-specific, so this adapter is
 * defensive and only extracts the facts the failure/fallback flow needs.
 */

export interface AgentOutcome {
  ok: boolean;
  /** Visible reply text, when the channel is responsible for sending it. */
  reply?: string;
  error?: unknown;
  /** Chatwoot message id when OpenClaw already delivered the reply itself. */
  deliveredMessageId?: number;
  /** True when OpenClaw already delivered a terminal error to the customer. */
  deliveredTerminalError?: boolean;
  /** Model actually used, when known. */
  model?: string;
  /** True when the model reported quota exhaustion. */
  quotaExhausted?: boolean;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

export function normalizeAgentResult(result: unknown): AgentOutcome {
  if (result === undefined || result === null) return { ok: true };
  const record = asRecord(result);
  if (!record) return { ok: true, reply: String(result) };

  const ok = record.ok !== false && record.success !== false && !record.error;
  const outcome: AgentOutcome = { ok };

  for (const key of ["reply", "text", "content", "message"]) {
    if (typeof record[key] === "string") {
      outcome.reply = record[key] as string;
      break;
    }
  }
  if (record.error) outcome.error = record.error;
  if (typeof record.deliveredMessageId === "number") outcome.deliveredMessageId = record.deliveredMessageId;
  if (typeof record.messageId === "number") outcome.deliveredMessageId = record.messageId;
  if (record.deliveredTerminalError === true) outcome.deliveredTerminalError = true;
  if (typeof record.model === "string") outcome.model = record.model;
  if (record.quotaExhausted === true) outcome.quotaExhausted = true;
  return outcome;
}
