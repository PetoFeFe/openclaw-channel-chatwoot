/**
 * Chatwoot public API client.
 *
 * Uses only documented public API v1 endpoints:
 *   POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages
 *   POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments
 *   GET  /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages
 *
 * Auth header: api_access_token
 *
 * A confirmed message id in the response is treated as the delivery receipt.
 */

export class ChatwootApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "ChatwootApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface ChatwootMessage {
  id: number;
  content: string;
  message_type: "incoming" | "outgoing" | "template";
  private: boolean;
  conversation_id?: number;
  created_at?: string;
}

export interface ChatwootConversation {
  id: number;
  status?: string;
  team_id?: number | null;
  assignee?: unknown;
}

export interface SendMessageInput {
  conversationId: string | number;
  content: string;
  private?: boolean;
  contentType?: string;
}

export interface SendMessageResult {
  /** Confirmed Chatwoot message id (delivery receipt), or null when unconfirmed. */
  messageId: number | null;
  raw: ChatwootMessage;
}

export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: string | number;
  apiToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep for deterministic retry tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Base delay for exponential backoff (ms). */
  backoffBaseMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatwootClient {
  private readonly baseUrl: string;
  private readonly accountId: string | number;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffBaseMs: number;

  constructor(options: ChatwootClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffBaseMs = options.backoffBaseMs ?? 200;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1/accounts/${this.accountId}${path}`;
  }

  /** Send an outgoing message (or a private note when private=true). */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const body = {
      content: input.content,
      message_type: "outgoing" as const,
      private: input.private ?? false,
      content_type: input.contentType ?? "text"
    };
    const raw = (await this.request(
      "POST",
      `/conversations/${input.conversationId}/messages`,
      body
    )) as ChatwootMessage;
    const messageId = typeof raw?.id === "number" ? raw.id : null;
    return { messageId, raw };
  }

  /** Assign a conversation to a team. */
  async assignTeam(conversationId: string | number, teamId: string | number): Promise<void> {
    await this.request("POST", `/conversations/${conversationId}/assignments`, {
      team_id: teamId
    });
  }

  /** Read recent messages/notes for a conversation (used for idempotency checks). */
  async listMessages(conversationId: string | number): Promise<ChatwootMessage[]> {
    const res = (await this.request(
      "GET",
      `/conversations/${conversationId}/messages`
    )) as { payload?: ChatwootMessage[] } | ChatwootMessage[];
    if (Array.isArray(res)) return res;
    return Array.isArray(res?.payload) ? res.payload : [];
  }

  async getConversation(conversationId: string | number): Promise<ChatwootConversation> {
    return (await this.request(
      "GET",
      `/conversations/${conversationId}`
    )) as ChatwootConversation;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestOnce(method, path, body);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ChatwootApiError ? RETRYABLE_STATUS.has(error.status) : isNetworkError(error);
        if (!retryable || attempt === this.maxRetries) throw error;
        const delay = this.backoffBaseMs * 2 ** attempt;
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  private async requestOnce(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          "content-type": "application/json",
          api_access_token: this.apiToken
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const code =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : undefined;
      throw new ChatwootApiError(
        `Chatwoot API ${method} ${path} failed with status ${response.status}`,
        response.status,
        code,
        parsed
      );
    }
    return parsed;
  }
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof ChatwootApiError) return false;
  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(
        error.message
      )
    );
  }
  return false;
}
