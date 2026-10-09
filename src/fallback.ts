import type { ChatwootChannelConfig } from "./types.js";
import type { FailureInfo } from "./failure.js";

/**
 * Configurable fallback-model behavior.
 *
 * On quota exhaustion or transient model failure, the plugin may retry the
 * agent run with the next configured fallback model. When the agent has already
 * delivered a terminal error response, the plugin must NOT send its own fallback
 * reply (avoid duplicate fallback replies).
 */

export type FallbackAction = "retry" | "fallback" | "handoff" | "alert" | "fail";

export interface FallbackDecision {
  action: FallbackAction;
  /** Model id to try next, for action "fallback". */
  model?: string;
  /** Optional customer-safe message for the "handoff" action. */
  customerMessage?: string;
}

export interface FallbackAttempt {
  /** Model ids already attempted, in order. */
  tried: string[];
  /** Model in use before this failure (may be undefined for default model). */
  currentModel?: string;
}

export function decideFallback(
  info: FailureInfo,
  config: Pick<ChatwootChannelConfig, "fallbackModels">,
  attempt: FallbackAttempt
): FallbackDecision {
  const fallbacks = config.fallbackModels ?? [];
  const tried = new Set(attempt.tried);
  const nextModel = fallbacks.find((model) => !tried.has(model));

  switch (info.class) {
    case "quota":
      // Quota is exhausted: move straight to the next fallback model.
      return nextModel ? { action: "fallback", model: nextModel } : { action: "handoff" };
    case "transient":
      // Transient: retry once, then fall back if models are configured.
      if (attempt.tried.length === 0) return { action: "retry" };
      return nextModel ? { action: "fallback", model: nextModel } : { action: "handoff" };
    case "auth":
      // Never surface provider errors to the customer; alert the operator.
      return { action: "alert" };
    case "delivery":
      // Outbound delivery failure: retry is handled by the client; if we get
      // here it is terminal for this turn.
      return { action: "handoff" };
    case "terminal":
    case "unknown":
    default:
      return { action: "handoff" };
  }
}

/**
 * Whether the plugin's own fallback reply must be suppressed because OpenClaw
 * has already delivered an error response to the customer.
 */
export function shouldSuppressFallbackReply(outcome: {
  deliveredTerminalError?: boolean;
  delivered?: boolean;
}): boolean {
  return outcome.deliveredTerminalError === true || outcome.delivered === true;
}
