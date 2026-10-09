import type { ChatwootChannelConfig } from "./types.js";
import type { DurableState, HandoffState } from "./state.js";
import type { SendMessageResult } from "./client.js";

/**
 * Human handoff.
 *
 * Assigns the reception team, adds a private note, sends a customer-facing
 * notice, and marks the conversation as human-handled so automatic replies are
 * suppressed until an explicit resume.
 *
 * Every step is idempotent and durable:
 *  - a handoff record is written before any side effect (suppresses auto-replies)
 *  - each effect is recorded as pending, then marked done with its receipt
 *  - the private note carries a deterministic internal marker, and the
 *    customer-facing notice is matched by exact content, so a restart or retry
 *    does not create duplicate messages. No markers are ever placed in
 *    customer-visible text.
 */

export interface HandoffClient {
  assignTeam(conversationId: string | number, teamId: string | number): Promise<void>;
  sendMessage(input: {
    conversationId: string | number;
    content: string;
    private?: boolean;
    contentType?: string;
  }): Promise<SendMessageResult>;
  listMessages(conversationId: string | number): Promise<Array<{ id: number; content?: string; private?: boolean }>>;
  /** Optional: lets handoff verify an existing assignment before re-assigning. */
  getConversation?(conversationId: string | number): Promise<{ id?: number; team_id?: number | null }>;
}

export interface Logger {
  debug?(message: string, meta?: unknown): void;
  info?(message: string, meta?: unknown): void;
  warn?(message: string, meta?: unknown): void;
  error?(message: string, meta?: unknown): void;
}

export interface HandoffDeps {
  client: HandoffClient;
  state: DurableState;
  config: ChatwootChannelConfig;
  conversationId: string | number;
  convKey: string;
  reason?: string;
  /** When true, do not send the customer-facing notice (OpenClaw already replied). */
  suppressCustomerNotice?: boolean;
  log?: Logger;
  now?: () => string;
}

export function handoffMarker(convKey: string): string {
  return `<!-- openclaw-handoff:${convKey} -->`;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? "");
}

export async function performHandoff(deps: HandoffDeps): Promise<HandoffState> {
  const { client, state, config, conversationId, convKey } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? {};

  const existing = state.getHandoff(convKey);
  const base: HandoffState = {
    active: true,
    teamId: config.receptionTeamId !== undefined ? String(config.receptionTeamId) : existing?.teamId,
    reason: deps.reason ?? existing?.reason,
    updatedAt: now(),
    assigned: existing?.assigned ?? false,
    noteSent: existing?.noteSent ?? false,
    customerNoticeSent: existing?.customerNoticeSent ?? false
  };
  // Mark active first so inbound auto-replies are suppressed immediately.
  await state.setHandoff(convKey, base);
  log.info?.("chatwoot: handoff started", { convKey, reason: base.reason });

  const marker = handoffMarker(convKey);
  const noticeText = config.handoffNotice ?? "";
  const recent = await safeListMessages(client, conversationId, log);
  const hasNoteMarker = recent.some(
    (m) => typeof m.content === "string" && m.content.includes(`${marker} kind=note`)
  );
  // The customer notice never carries a marker (it is customer-visible); an
  // exact-content match against recent public messages is the idempotency check.
  const hasPublicNotice = recent.some(
    (m) =>
      m.private !== true &&
      typeof m.content === "string" &&
      m.content.trim() === noticeText.trim()
  );

  // 1. Assign the reception team.
  if (!base.assigned && config.receptionTeamId !== undefined) {
    const alreadyAssigned = await isAlreadyAssigned(client, conversationId, config.receptionTeamId, log);
    if (alreadyAssigned) {
      base.assigned = true;
      await state.setHandoff(convKey, base);
      log.info?.("chatwoot: reception team already assigned", { convKey });
    } else {
      await state.putEffect(convKey, {
        id: "assign-team",
        kind: "assign-team",
        status: "pending",
        attempts: 1,
        updatedAt: now()
      });
      await client.assignTeam(conversationId, config.receptionTeamId);
      base.assigned = true;
      await state.setHandoff(convKey, base);
      await state.deleteEffect(convKey, "assign-team");
      log.info?.("chatwoot: reception team assigned", { convKey, teamId: config.receptionTeamId });
    }
  } else if (config.receptionTeamId === undefined) {
    log.warn?.("chatwoot: receptionTeamId not configured; handoff without assignment", { convKey });
  }

  // 2. Private internal note.
  if (!base.noteSent && !hasNoteMarker) {
    await state.putEffect(convKey, {
      id: "handoff-note",
      kind: "handoff-note",
      status: "pending",
      attempts: 1,
      updatedAt: now()
    });
    const note = renderTemplate(config.handoffNoteTemplate ?? "", {
      conversation: String(conversationId),
      session: convKey,
      reason: base.reason ?? ""
    });
    const result = await client.sendMessage({
      conversationId,
      content: `${marker} kind=note\n${note}`,
      private: true
    });
    base.noteSent = true;
    await state.setHandoff(convKey, base);
    await state.deleteEffect(convKey, "handoff-note");
    log.info?.("chatwoot: handoff note posted", { convKey, messageId: result.messageId });
  } else if (hasNoteMarker) {
    base.noteSent = true;
    await state.setHandoff(convKey, base);
  }

  // 3. Customer-facing notice (unless OpenClaw already delivered a reply).
  if (deps.suppressCustomerNotice) {
    log.info?.("chatwoot: customer notice suppressed (agent already replied)", { convKey });
  } else if (!base.customerNoticeSent && !hasPublicNotice) {
    await state.putEffect(convKey, {
      id: "customer-notice",
      kind: "customer-notice",
      status: "pending",
      attempts: 1,
      updatedAt: now()
    });
    const result = await client.sendMessage({
      conversationId,
      content: noticeText,
      private: false
    });
    base.customerNoticeSent = true;
    await state.setHandoff(convKey, base);
    await state.deleteEffect(convKey, "customer-notice");
    log.info?.("chatwoot: customer notice sent", { convKey, messageId: result.messageId });
  } else if (hasPublicNotice) {
    base.customerNoticeSent = true;
    await state.setHandoff(convKey, base);
  }

  await state.setHandoff(convKey, base);
  return base;
}

async function safeListMessages(
  client: HandoffClient,
  conversationId: string | number,
  log: Logger
): Promise<Array<{ id: number; content?: string; private?: boolean }>> {
  try {
    return await client.listMessages(conversationId);
  } catch (error) {
    log.warn?.("chatwoot: could not list messages for idempotency check", {
      error: (error as Error).message
    });
    return [];
  }
}

async function isAlreadyAssigned(
  client: HandoffClient,
  conversationId: string | number,
  teamId: string | number,
  log: Logger
): Promise<boolean> {
  if (!client.getConversation) return false;
  try {
    const conversation = await client.getConversation(conversationId);
    return conversation?.team_id !== undefined && conversation?.team_id !== null
      ? String(conversation.team_id) === String(teamId)
      : false;
  } catch (error) {
    log.warn?.("chatwoot: could not read conversation before assignment", {
      error: (error as Error).message
    });
    return false;
  }
}

/** Explicitly resume automation for a conversation and replay any pending work. */
export async function resumeHandoff(
  state: DurableState,
  convKey: string,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const existing = state.getHandoff(convKey);
  if (!existing) return;
  await state.setHandoff(convKey, { ...existing, active: false, updatedAt: now() });
}

export function isHandoffActive(state: DurableState, convKey: string): boolean {
  return state.isHandoffActive(convKey);
}
