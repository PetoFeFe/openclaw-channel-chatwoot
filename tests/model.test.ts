import { describe, expect, it } from "vitest";
import { normalizeAgentResult } from "../src/model.js";

describe("agent outcome normalization", () => {
  it("treats missing results as success", () => {
    expect(normalizeAgentResult(undefined)).toEqual({ ok: true });
  });

  it("extracts a reply and delivery receipt", () => {
    expect(normalizeAgentResult({ reply: "hi", messageId: 7 })).toMatchObject({
      ok: true,
      reply: "hi",
      deliveredMessageId: 7
    });
  });

  it("marks failures and terminal deliveries", () => {
    expect(normalizeAgentResult({ ok: false, error: new Error("x"), deliveredTerminalError: true })).toMatchObject({
      ok: false,
      deliveredTerminalError: true
    });
  });

  it("captures quota exhaustion", () => {
    expect(normalizeAgentResult({ ok: false, quotaExhausted: true })).toMatchObject({
      ok: false,
      quotaExhausted: true
    });
  });
});
