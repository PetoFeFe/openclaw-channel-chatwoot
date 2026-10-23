export function makeMessageEvent(options: {
  accountId?: number;
  conversationId: number;
  messageId?: number;
  content?: string;
  messageType?: string | number;
  priv?: boolean;
  senderType?: string;
  inboxId?: number;
  status?: string;
}): Record<string, unknown> {
  return {
    event: "message_created",
    id: options.messageId ?? 1,
    content: options.content ?? "hello",
    message_type: options.messageType ?? "incoming",
    private: options.priv ?? false,
    content_type: "text",
    account: { id: options.accountId ?? 1 },
    conversation: { id: options.conversationId, status: options.status ?? "open" },
    ...(options.inboxId !== undefined ? { inbox: { id: options.inboxId, name: "bot" } } : {}),
    sender: { id: 42, type: options.senderType ?? "contact" }
  };
}
