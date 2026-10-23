/**
 * Deterministic session routing.
 *
 * Every Chatwoot conversation maps to exactly one OpenClaw session:
 *   chatwoot:<account_id>:<conversation_id>
 * which keeps conversations isolated from each other.
 */

export function sessionKey(accountId: string | number, conversationId: string | number): string {
  return `chatwoot:${String(accountId)}:${String(conversationId)}`;
}

export interface ParsedSessionKey {
  accountId: string;
  conversationId: string;
}

export function parseSessionKey(key: string): ParsedSessionKey | null {
  const match = /^chatwoot:([^:]+):([^:]+)$/.exec(key);
  if (!match) return null;
  return { accountId: match[1], conversationId: match[2] };
}
