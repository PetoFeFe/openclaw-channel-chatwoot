import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_HEADER,
  DEFAULT_WEBHOOK_PATH,
  DEFAULT_WEBHOOK_TOLERANCE_SEC,
  normalizeChannelConfig
} from "../src/types.js";

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
    // accountId has an env fallback (CHATWOOT_ACCOUNT_ID); clear it so the
    // "accountId is required" path is exercised regardless of deployment env.
    const saved = process.env.CHATWOOT_ACCOUNT_ID;
    delete process.env.CHATWOOT_ACCOUNT_ID;
    try {
      expect(() => normalizeChannelConfig({ baseUrl: "https://x" })).toThrow(/accountId/);
    } finally {
      if (saved !== undefined) process.env.CHATWOOT_ACCOUNT_ID = saved;
    }
    expect(() => normalizeChannelConfig({ baseUrl: "https://x", accountId: 1 })).toThrow(/apiToken/);
  });

  it("falls back to CHATWOOT_ACCOUNT_ID when accountId is absent", () => {
    const saved = process.env.CHATWOOT_ACCOUNT_ID;
    process.env.CHATWOOT_ACCOUNT_ID = "42";
    try {
      const config = normalizeChannelConfig({ baseUrl: "https://x", apiToken: "t" });
      expect(config.accountId).toBe("42");
    } finally {
      if (saved === undefined) delete process.env.CHATWOOT_ACCOUNT_ID;
      else process.env.CHATWOOT_ACCOUNT_ID = saved;
    }
  });

  it("defaults to native Chatwoot webhook signing", () => {
    const config = normalizeChannelConfig({ baseUrl: "https://x", accountId: 1, apiToken: "t" });
    expect(config.webhookSignatureMode).toBe("chatwoot");
    expect(config.webhookTimestampToleranceSec).toBe(DEFAULT_WEBHOOK_TOLERANCE_SEC);
    expect(config.webhookHeader).toBe(DEFAULT_WEBHOOK_HEADER);
  });

  it("supports an explicit custom signature mode", () => {
    const config = normalizeChannelConfig({
      baseUrl: "https://x",
      accountId: 1,
      apiToken: "t",
      webhookSignatureMode: "custom",
      webhookHeader: "x-signature",
      webhookTimestampToleranceSec: 60
    });
    expect(config.webhookSignatureMode).toBe("custom");
    expect(config.webhookHeader).toBe("x-signature");
    expect(config.webhookTimestampToleranceSec).toBe(60);
  });
});
