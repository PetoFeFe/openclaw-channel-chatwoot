import { describe, expect, it } from "vitest";
import { ChatwootApiError } from "../src/client.js";
import { classifyError, customerSafeMessage } from "../src/failure.js";

describe("failure classification", () => {
  it("treats network errors as transient", () => {
    expect(classifyError(new Error("fetch failed")).class).toBe("transient");
  });

  it("treats 5xx model errors as transient", () => {
    expect(classifyError({ status: 503, message: "upstream" }).class).toBe("transient");
  });

  it("treats rate limiting as transient", () => {
    expect(classifyError({ status: 429, code: "rate_limit_exceeded" }).class).toBe("transient");
  });

  it("treats insufficient_quota as quota", () => {
    expect(classifyError({ status: 429, code: "insufficient_quota" }).class).toBe("quota");
    expect(classifyError(new Error("quota exceeded for model")).class).toBe("quota");
  });

  it("treats auth failures as auth", () => {
    expect(classifyError({ status: 401 }).class).toBe("auth");
    expect(classifyError(new Error("invalid api token")).class).toBe("auth");
  });

  it("treats Chatwoot send failures as delivery", () => {
    expect(classifyError(new ChatwootApiError("nope", 500), "chatwoot").class).toBe("delivery");
  });

  it("never exposes internals to the customer", () => {
    const message = customerSafeMessage(classifyError({ status: 503 }));
    expect(message).toBeUndefined();
    const handoffMessage = customerSafeMessage(classifyError(new Error("boom")));
    if (handoffMessage !== undefined) {
      expect(handoffMessage).not.toMatch(/boom|status|token/i);
    }
  });
});
