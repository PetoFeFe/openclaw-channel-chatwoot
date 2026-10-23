import { describe, expect, it } from "vitest";
import { parseSessionKey, sessionKey } from "../src/routing.js";

describe("routing", () => {
  it("builds deterministic session keys", () => {
    expect(sessionKey(1, 42)).toBe("chatwoot:1:42");
    expect(sessionKey("1", "42")).toBe("chatwoot:1:42");
  });

  it("isolates conversations", () => {
    expect(sessionKey(1, 42)).not.toBe(sessionKey(1, 43));
    expect(sessionKey(1, 42)).not.toBe(sessionKey(2, 42));
  });

  it("round-trips session keys", () => {
    expect(parseSessionKey("chatwoot:9:77")).toEqual({ accountId: "9", conversationId: "77" });
    expect(parseSessionKey("nope")).toBeNull();
  });
});
