import { describe, expect, it } from "vitest";
import { decideFallback, shouldSuppressFallbackReply } from "../src/fallback.js";
import type { FailureInfo } from "../src/failure.js";

function info(overrides: Partial<FailureInfo>): FailureInfo {
  return { class: "terminal", retryable: false, operatorDetail: "", ...overrides };
}

const config = { fallbackModels: ["gpt-4o-mini", "gpt-4.1-mini"] };

describe("fallback decisions", () => {
  it("falls back to the next model on quota exhaustion", () => {
    expect(decideFallback(info({ class: "quota" }), config, { tried: [] })).toEqual({
      action: "fallback",
      model: "gpt-4o-mini"
    });
  });

  it("skips already-tried models", () => {
    expect(decideFallback(info({ class: "quota" }), config, { tried: ["gpt-4o-mini"] })).toEqual({
      action: "fallback",
      model: "gpt-4.1-mini"
    });
  });

  it("hands off when fallbacks are exhausted", () => {
    expect(
      decideFallback(info({ class: "quota" }), config, { tried: ["gpt-4o-mini", "gpt-4.1-mini"] })
    ).toEqual({ action: "handoff" });
  });

  it("retries transient errors before falling back", () => {
    expect(decideFallback(info({ class: "transient", retryable: true }), config, { tried: [] })).toEqual({
      action: "retry"
    });
  });

  it("alerts the operator on auth errors (no customer message)", () => {
    expect(decideFallback(info({ class: "auth" }), config, { tried: [] })).toEqual({ action: "alert" });
  });

  it("hands off on terminal errors", () => {
    expect(decideFallback(info({ class: "terminal" }), config, { tried: [] })).toEqual({
      action: "handoff"
    });
  });

  it("suppresses duplicate fallback replies once a reply was delivered", () => {
    expect(shouldSuppressFallbackReply({ deliveredTerminalError: true })).toBe(true);
    expect(shouldSuppressFallbackReply({ delivered: true })).toBe(true);
    expect(shouldSuppressFallbackReply({})).toBe(false);
  });
});
