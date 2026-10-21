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
  /** String enum in some serializers, integer (0/1/2) in others. */
  message_type: "incoming" | "outgoing" | "template" | number;
  private: boolean;
  conversation_id?: number;
  created_at?: string | number;
  sender?: { id?: number; type?: string; name?: string };
}

export interface ChatwootConversation {
  id: number;
  status?: string;
  team_id?: number | null;
  inbox_id?: number;
  assignee?: unknown;
  last_activity_at?: number;
}

export interface SendMessageInput {
  conversationId: string | number;
  content: string;
  private?: boolean;
  contentType?: string;
  /**
   * Image/media URLs to attach to the outgoing message. Chatwoot-hosted media
   * (active storage `/rails/...` paths) is fetched from `baseUrl` first so an
   * internal Docker URL works even when the public host has an untrusted cert.
   */
  attachments?: string[];
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
    const attachments = (input.attachments ?? [])
      .map((url) => String(url ?? "").trim())
      .filter(Boolean);
    const path = `/conversations/${input.conversationId}/messages`;
    const raw = (attachments.length > 0
      ? await this.sendWithAttachments(path, input, attachments)
      : await this.request("POST", path, {
          content: input.content,
          message_type: "outgoing" as const,
          private: input.private ?? false,
          content_type: input.contentType ?? "text"
        })) as ChatwootMessage;
    const messageId = typeof raw?.id === "number" ? raw.id : null;
    return { messageId, raw };
  }

  /**
   * Download each attachment and upload it with the caption as one Chatwoot
   * message. Falls back to a plain text send when nothing is fetchable, so a
   * bad image URL never drops the reply.
   */
  private async sendWithAttachments(
    path: string,
    input: SendMessageInput,
    urls: string[]
  ): Promise<ChatwootMessage> {
    const files: Array<{ blob: Blob; filename: string }> = [];
    for (const url of urls) {
      const file = await this.fetchMedia(url);
      if (file) files.push(file);
    }
    if (files.length === 0) {
      return (await this.request("POST", path, {
        content: input.content,
        message_type: "outgoing",
        private: input.private ?? false,
        content_type: input.contentType ?? "text"
      })) as ChatwootMessage;
    }
    const form = new FormData();
    form.set("content", input.content);
    form.set("message_type", "outgoing");
    form.set("private", String(input.private ?? false));
    for (const file of files) form.append("attachments[]", file.blob, file.filename);
    return (await this.requestForm(path, form)) as ChatwootMessage;
  }

  private async fetchMedia(url: string): Promise<{ blob: Blob; filename: string } | null> {
    for (const candidate of mediaCandidates(url, this.baseUrl)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(candidate, { signal: controller.signal });
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = res.headers.get("content-type") ?? "application/octet-stream";
        return { blob: new Blob([bytes], { type }), filename: filenameFromUrl(candidate) };
      } catch {
        // Try the next candidate URL.
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
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

  /** Send a private (internal) note; never customer-visible. */
  async sendPrivateNote(conversationId: string | number, content: string): Promise<SendMessageResult> {
    return this.sendMessage({ conversationId, content, private: true });
  }

  async getConversation(conversationId: string | number): Promise<ChatwootConversation> {
    return (await this.request(
      "GET",
      `/conversations/${conversationId}`
    )) as ChatwootConversation;
  }

  /**
   * List conversations by status (used by the queue reconciler). Returns the
   * raw payload items; callers narrow by inbox/status fields.
   */
  async listConversationsByStatus(status: "pending" | "open" | "resolved"): Promise<unknown[]> {
    const res = (await this.request("GET", `/conversations?status=${status}&sort=last_activity_desc`)) as
      | { payload?: unknown[] }
      | unknown[];
    if (Array.isArray(res)) return res;
    return Array.isArray(res?.payload) ? res.payload : [];
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

    return this.parseResponse(method, path, response);
  }

  private async requestForm(path: string, form: FormData): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestFormOnce(path, form);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ChatwootApiError
            ? RETRYABLE_STATUS.has(error.status)
            : isNetworkError(error);
        if (!retryable || attempt === this.maxRetries) throw error;
        await this.sleep(this.backoffBaseMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async requestFormOnce(path: string, form: FormData): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers: { api_access_token: this.apiToken },
        body: form,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    return this.parseResponse("POST", path, response);
  }

  private async parseResponse(method: string, path: string, response: Response): Promise<unknown> {
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

/**
 * Candidate URLs to fetch an attachment from. Chatwoot-hosted active-storage
 * media is tried through the configured `baseUrl` first (internal Docker DNS,
 * trusted), then through the URL as given.
 */
function mediaCandidates(rawUrl: string, baseUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (parsed.pathname.startsWith("/rails/") || parsed.pathname.startsWith("/storage/")) {
    out.push(`${baseUrl}${parsed.pathname}${parsed.search}`);
  }
  out.push(rawUrl);
  return out.filter((url, index) => out.indexOf(url) === index);
}

function filenameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
  } catch {
    // fall through to the generic name
  }
  return "attachment";
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
