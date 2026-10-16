/**
 * Agent-requested human handoff.
 *
 * The Chatwoot channel delivers an agent's assistant text to the customer. To
 * let the agent *escalate* to a human team as part of its business policy (for
 * example Tata's Level 1 reception / Level 2 administration flow) without
 * exposing control characters to the customer, the agent may end its reply with
 * a single directive line:
 *
 *     [[chatwoot-handoff team=2 reason=cliente pediu administracao]]
 *
 * The text before the directive is the customer-facing notice; the plugin strips
 * the directive, performs the handoff to `team`, and sends the notice as the
 * handoff message. A directive on its own (empty notice) falls back to the
 * configured `handoffNotice`.
 *
 * Parsing is intentionally strict and line-anchored so ordinary prose that
 * merely mentions "handoff" is never interpreted as control input.
 */

export interface HandoffDirective {
  /** Customer-facing text with the directive line removed (may be empty). */
  notice: string;
  /** Requested team id, when present. */
  teamId?: string;
  /** Short human-readable reason, when present. */
  reason?: string;
}

// One directive line: `[[chatwoot-handoff ...]]` (case-insensitive), alone on a line.
const DIRECTIVE_LINE = /^[ \t]*\[\[[ \t]*chatwoot-handoff\b([^\]]*)\]\][ \t]*$/i;
const TEAM_ATTR = /\bteam\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/i;
const REASON_ATTR = /\breason\s*=\s*(.+?)\s*$/i;

/**
 * Parse an agent reply for a handoff directive.
 *
 * Returns `undefined` when no directive is present, so callers can treat the
 * text as a normal reply.
 */
export function parseHandoffDirective(text: string): HandoffDirective | undefined {
  if (typeof text !== "string" || !/chatwoot-handoff/i.test(text)) return undefined;
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let teamId: string | undefined;
  let reason: string | undefined;
  let found = false;

  for (const line of lines) {
    const match = DIRECTIVE_LINE.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    found = true;
    const attrs = match[1] ?? "";
    const team = TEAM_ATTR.exec(attrs);
    if (team) teamId = (team[2] ?? team[3] ?? team[4] ?? "").trim() || undefined;
    const reasonMatch = REASON_ATTR.exec(attrs);
    if (reasonMatch) reason = reasonMatch[1].trim() || undefined;
  }

  if (!found) return undefined;
  return {
    notice: kept.join("\n").trim(),
    teamId,
    reason
  };
}

/** Strip any handoff directive from text without interpreting it. */
export function stripHandoffDirective(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !DIRECTIVE_LINE.test(line))
    .join("\n")
    .trim();
}
