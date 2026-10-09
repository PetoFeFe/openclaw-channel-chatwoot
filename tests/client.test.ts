import { describe, expect, it, vi } from "vitest";
import { ChatwootApiError, ChatwootClient } from "../src/client.js";
import { classifyError } from "../src/failure.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const base = {
  baseUrl: "https://chatwoot.test",
  accountId: 7,
  apiToken: "tok",
  sleep: async () => {}
};

describe("ChatwootClient", () => {
  it("sends an outgoing message and returns the confirmed receipt id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: 321, content: "hi" }));
    const client = new ChatwootClient({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.sendMessage({ conversationId: 55, content: "hi" });

    expect(result.messageId).toBe(321);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://chatwoot.test/api/v1/accounts/7/conversations/55/messages");
    expect(init?.headers).toMatchObject({ api_access_token: "tok" });
    expect(JSON.parse(String(init?.body))).toEqual({
      content: "hi",
      message_type: "outgoing",
      private: false,
      content_type: "text"
    });
  });

  it("sends a private note when private=true", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: 1 }));
    const client = new ChatwootClient({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendMessage({ conversationId: 55, content: "note", private: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.private).toBe(true);
  });

  it("retries transient 5xx failures then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 9 }));
    const client = new ChatwootClient({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.sendMessage({ conversationId: 1, content: "x" });
    expect(result.messageId).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const client = new ChatwootClient({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendMessage({ conversationId: 1, content: "x" })).rejects.toBeInstanceOf(
      ChatwootApiError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies Chatwoot 5xx delivery failures", async () => {
    const error = new ChatwootApiError("boom", 500);
    expect(classifyError(error, "chatwoot").class).toBe("delivery");
  });
});
