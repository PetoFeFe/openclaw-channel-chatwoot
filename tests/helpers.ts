import type { HandoffClient } from "../src/handoff.js";
import type { ChatwootMessage, SendMessageResult } from "../src/client.js";

/**
 * In-process mock of the Chatwoot public API used by tests. Records every call
 * and can be programmed to fail, so the plugin's own logic is exercised without
 * running Chatwoot.
 */
export class MockChatwoot implements HandoffClient {
  calls: Array<{ method: string; conversationId: string | number; body?: unknown }> = [];
  messages: Array<ChatwootMessage & { conversationId: string | number }> = [];
  assignments: Array<{ conversationId: string | number; teamId: string | number }> = [];
  conversations = new Map<string | number, { id?: number; team_id?: number | null }>();
  private nextId = 1000;
  failSend: Error | undefined;
  failAssign: Error | undefined;

  async sendMessage(input: {
    conversationId: string | number;
    content: string;
    private?: boolean;
  }): Promise<SendMessageResult> {
    if (this.failSend) throw this.failSend;
    this.calls.push({ method: "sendMessage", conversationId: input.conversationId, body: input });
    const message: ChatwootMessage & { conversationId: string | number } = {
      id: this.nextId++,
      content: input.content,
      message_type: "outgoing",
      private: input.private ?? false,
      conversationId: input.conversationId
    };
    this.messages.push(message);
    return { messageId: message.id, raw: message };
  }

  async assignTeam(conversationId: string | number, teamId: string | number): Promise<void> {
    if (this.failAssign) throw this.failAssign;
    this.calls.push({ method: "assignTeam", conversationId, body: { teamId } });
    this.assignments.push({ conversationId, teamId });
    this.conversations.set(conversationId, { id: Number(conversationId) || 0, team_id: Number(teamId) || null });
  }

  async getConversation(conversationId: string | number): Promise<{ id?: number; team_id?: number | null }> {
    return this.conversations.get(conversationId) ?? { id: Number(conversationId) || 0, team_id: null };
  }

  async listMessages(conversationId: string | number): Promise<ChatwootMessage[]> {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }

  sentContents(): string[] {
    return this.messages.map((m) => m.content);
  }

  privateMessages(): Array<ChatwootMessage & { conversationId: string | number }> {
    return this.messages.filter((m) => m.private === true);
  }

  publicMessages(): Array<ChatwootMessage & { conversationId: string | number }> {
    return this.messages.filter((m) => m.private !== true);
  }
}

export function makeMessageEvent(options: {
  accountId?: number;
  conversationId: number;
  messageId?: number;
  content?: string;
  messageType?: string;
  priv?: boolean;
  senderType?: string;
}): Record<string, unknown> {
  return {
    event: "message_created",
    id: options.messageId ?? 1,
    content: options.content ?? "hello",
    message_type: options.messageType ?? "incoming",
    private: options.priv ?? false,
    content_type: "text",
    account: { id: options.accountId ?? 1 },
    conversation: { id: options.conversationId, status: "open" },
    sender: { id: 42, type: options.senderType ?? "contact" }
  };
}

export function makeConversationEvent(options: {
  accountId?: number;
  conversationId: number;
  event?: string;
  teamId?: number | null;
  status?: string;
}): Record<string, unknown> {
  // Real Chatwoot conversation_* payloads are flat (no nested `conversation`).
  return {
    event: options.event ?? "conversation_updated",
    account: { id: options.accountId ?? 1 },
    id: options.conversationId,
    status: options.status ?? "open",
    team_id: options.teamId ?? null
  };
}
