import { describe, expect, it } from "vitest";
import { DEFAULT_WEBHOOK_PATH, normalizeChannelConfig } from "../src/types.js";

describe("channel config", () => {
  it("normalizes required fields and strips a trailing slash", () => {
    const config = normalizeChannelConfig({
      baseUrl: "https://chatwoot.test/",
      accountId: "3",
      apiToken: "tok"
    });
    expect(config.baseUrl).toBe("https://chatwoot.test");
    expect(config.accountId).toBe("3");
    expect(config.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
  });

  it("requires baseUrl, accountId and apiToken", () => {
    expect(() => normalizeChannelConfig({})).toThrow(/baseUrl/);
    expect(() => normalizeChannelConfig({ baseUrl: "https://x" })).toThrow(/accountId/);
    expect(() => normalizeChannelConfig({ baseUrl: "https://x", accountId: 1 })).toThrow(/apiToken/);
  });

  it("keeps optional handoff and fallback settings", () => {
    const config = normalizeChannelConfig({
      baseUrl: "https://x",
      accountId: 1,
      apiToken: "t",
      receptionTeamId: 5,
      fallbackModels: ["a", "b"],
      maxRetries: 1
    });
    expect(config.receptionTeamId).toBe(5);
    expect(config.fallbackModels).toEqual(["a", "b"]);
    expect(config.maxRetries).toBe(1);
  });
});
