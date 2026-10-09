import { ChatwootApiError, isNetworkError } from "./client.js";

/**
 * Failure classification.
 *
 * Distinguishes the failure modes the task cares about:
 *   transient   - retryable network / 5xx / rate-limit errors
 *   quota       - model/provider quota exhausted -> try fallback model
 *   auth        - authentication / configuration errors -> alert operator
 *   delivery    - outbound message failed to deliver
 *   terminal    - unrecoverable agent failure -> hand off to reception
 */

export type FailureClass = "transient" | "quota" | "auth" | "delivery" | "terminal" | "unknown";

export type FailureSource = "chatwoot" | "model" | "agent";

export interface FailureInfo {
  class: FailureClass;
  retryable: boolean;
  /** Whether the customer may be shown a generic message. Never includes internals. */
  customerSafeMessage?: string;
  /** Operator-facing detail. Never sent to the customer. */
  operatorDetail: string;
  status?: number;
  code?: string;
}

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
  "billing_hard_limit_reached",
  "account_deactivated"
]);

const AUTH_CODES = new Set([
  "invalid_api_key",
  "invalid_token",
  "authentication_error",
  "unauthorized",
  "forbidden",
  "access_denied"
]);

function extractStatus(error: unknown): number | undefined {
  if (error instanceof ChatwootApiError) return error.status;
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
    if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);
  }
  return undefined;
}

function extractCode(error: unknown): string | undefined {
  if (error instanceof ChatwootApiError) return error.code;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["code", "type", "error"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyError(error: unknown, source: FailureSource = "agent"): FailureInfo {
  const status = extractStatus(error);
  const code = extractCode(error);
  const message = messageOf(error);
  const lower = `${code ?? ""} ${message}`.toLowerCase();

  // Quota exhaustion (429 with a quota code, or explicit quota wording).
  if (code && QUOTA_CODES.has(code)) {
    return { class: "quota", retryable: false, operatorDetail: message, status, code };
  }
  if (lower.includes("insufficient_quota") || lower.includes("quota_exhausted") || lower.includes("quota exceeded")) {
    return { class: "quota", retryable: false, operatorDetail: message, status, code };
  }

  // Auth / configuration errors.
  if (status === 401 || status === 403 || (code && AUTH_CODES.has(code))) {
    return { class: "auth", retryable: false, operatorDetail: message, status, code };
  }
  if (lower.includes("invalid api token") || lower.includes("unauthorized") || lower.includes("authentication")) {
    return { class: "auth", retryable: false, operatorDetail: message, status, code };
  }

  // Rate limiting without a quota code is transient.
  if (status === 429) {
    return { class: "transient", retryable: true, operatorDetail: message, status, code };
  }

  // Transient transport / server failures.
  if ((status !== undefined && status >= 500) || isNetworkError(error)) {
    if (source === "chatwoot") {
      return {
        class: "delivery",
        retryable: true,
        operatorDetail: message,
        status,
        code
      };
    }
    return { class: "transient", retryable: true, operatorDetail: message, status, code };
  }

  // Outbound failure from the Chatwoot API client.
  if (error instanceof ChatwootApiError) {
    if (source === "chatwoot") {
      return { class: "delivery", retryable: status !== undefined && status < 500, operatorDetail: message, status, code };
    }
    return { class: "terminal", retryable: false, operatorDetail: message, status, code };
  }

  // Explicit terminal marker.
  if (error && typeof error === "object" && (error as { terminal?: unknown }).terminal === true) {
    return { class: "terminal", retryable: false, operatorDetail: message, status, code };
  }

  return { class: "unknown", retryable: false, operatorDetail: message, status, code };
}

/** Generic, non-revealing customer message for a failure class (or undefined). */
export function customerSafeMessage(info: FailureInfo): string | undefined {
  switch (info.class) {
    case "delivery":
    case "terminal":
      return "I'm having trouble completing that right now. Let me get a teammate to help.";
    default:
      return undefined;
  }
}
