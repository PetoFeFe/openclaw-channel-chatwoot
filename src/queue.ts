import type { Dispatch, DispatchRequest } from "./handler.js";

/**
 * Per-conversation turn lanes.
 *
 * Chatwoot delivers webhooks independently, so a customer who sends two quick
 * messages ("Oi", then "Bom dia") produces two concurrent webhooks. Without
 * serialization the plugin starts two agent turns on the same session at the
 * same time; both see an empty transcript and both greet the customer.
 *
 * A lane gives us, per conversation:
 *   - serialization: only one agent turn runs at a time, in arrival order;
 *   - coalescing: a burst arriving inside `settleMs` is merged into a single
 *     turn so the agent answers the burst once, with full context.
 *
 * `run()` resolves only after the turn that contains the message has been
 * dispatched. Callers await it from inside the registered HTTP handler, which
 * keeps the Gateway root task admitted for the whole agent run (an unawaited
 * dispatch is what produced `GatewayDrainingError`).
 *
 * Lanes are in-process only. A gateway restart drops turns that were acked but
 * not yet dispatched; Chatwoot retains the conversation, so an operator can
 * resume from there. Cross-restart replay is deliberately out of scope here.
 */

export interface LaneLog {
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  error?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ConversationLanesOptions {
  dispatch: Dispatch;
  /**
   * Coalescing window in milliseconds applied before the first batch of a
   * burst is dispatched. `0` disables coalescing (dispatch each message as it
   * arrives) while keeping serialization.
   */
  settleMs?: number;
  /**
   * Maximum dispatch attempts for one batch when the Gateway reports that it is
   * temporarily draining (`GatewayDrainingError`). The Gateway closes work
   * admission for short windows (suspend / restart); such a turn was never
   * started, so it is safe to retry. `1` disables retries.
   */
  dispatchRetries?: number;
  /** Backoff between dispatch retries, in milliseconds. Defaults to exponential. */
  retryBackoffMs?: (attempt: number) => number;
  log?: LaneLog;
}

export const DEFAULT_SETTLE_MS = 800;
export const DEFAULT_DISPATCH_RETRIES = 5;

/** True when the error is the Gateway's transient admission/drain rejection. */
export function isGatewayDrainingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gateway is draining|draining for restart/i.test(message);
}

/** Exponential backoff between dispatch retries: 400, 800, 1600, … capped at 10s. */
export function defaultRetryBackoffMs(attempt: number): number {
  return Math.min(10_000, 400 * 2 ** (attempt - 1));
}

interface QueueEntry {
  request: DispatchRequest;
  done: () => void;
}

interface Lane {
  entries: QueueEntry[];
  running: boolean;
}

export class ConversationLanes {
  private readonly lanes = new Map<string, Lane>();
  private readonly dispatch: Dispatch;
  private readonly settleMs: number;
  private readonly dispatchRetries: number;
  private readonly retryBackoffMs: (attempt: number) => number;
  private readonly log: LaneLog;

  constructor(options: ConversationLanesOptions) {
    this.dispatch = options.dispatch;
    this.settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    this.dispatchRetries = Math.max(1, options.dispatchRetries ?? DEFAULT_DISPATCH_RETRIES);
    this.retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
    this.log = options.log ?? {};
  }

  /**
   * Enqueue a message for a conversation and resolve once its (possibly
   * coalesced) agent turn has been dispatched.
   */
  run(convKey: string, request: DispatchRequest): Promise<void> {
    let lane = this.lanes.get(convKey);
    if (!lane) {
      lane = { entries: [], running: false };
      this.lanes.set(convKey, lane);
    }
    const current = lane;
    const settled = new Promise<void>((resolve) => {
      current.entries.push({ request, done: resolve });
    });
    if (!current.running) {
      current.running = true;
      void this.pump(convKey, current);
    }
    return settled;
  }

  /** Messages waiting to be dispatched for a conversation. */
  pending(convKey: string): number {
    return this.lanes.get(convKey)?.entries.length ?? 0;
  }

  private async pump(convKey: string, lane: Lane): Promise<void> {
    try {
      if (this.settleMs > 0) await delay(this.settleMs);
      while (lane.entries.length > 0) {
        const batch = lane.entries.splice(0, lane.entries.length);
        await this.dispatchBatch(convKey, batch);
      }
    } catch (error) {
      this.log.error?.("chatwoot: conversation lane failed", {
        conversationKey: convKey,
        error: (error as Error).message
      });
    } finally {
      if (lane.entries.length > 0) {
        // A message arrived after the drain check; keep running this lane.
        void this.pump(convKey, lane);
        return;
      }
      lane.running = false;
      if (this.lanes.get(convKey) === lane) this.lanes.delete(convKey);
    }
  }

  private async dispatchBatch(convKey: string, batch: QueueEntry[]): Promise<void> {
    const request = combineRequests(batch.map((entry) => entry.request));
    try {
      await this.dispatchWithRetry(convKey, request);
    } finally {
      for (const entry of batch) entry.done();
    }
  }

  /**
   * Dispatch a batch, retrying with backoff while the Gateway is draining.
   *
   * The Gateway closes work admission for short windows (suspend / restart) and
   * rejects new tasks with `GatewayDrainingError`. Nothing has run yet when that
   * is thrown, so the turn can safely be retried; failing fast would leave the
   * customer's acked message unanswered.
   */
  private async dispatchWithRetry(convKey: string, request: DispatchRequest): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.dispatch(request);
        return;
      } catch (error) {
        const draining = isGatewayDrainingError(error);
        if (draining && attempt < this.dispatchRetries) {
          this.log.warn?.("chatwoot: gateway draining; deferring lane dispatch", {
            conversationKey: convKey,
            attempt,
            maxAttempts: this.dispatchRetries
          });
          await delay(this.retryBackoffMs(attempt));
          continue;
        }
        this.log.error?.("chatwoot: lane dispatch failed", {
          conversationKey: convKey,
          attempt,
          draining,
          error: (error as Error).message
        });
        return;
      }
    }
  }
}

/** Merge a coalesced burst into a single turn, preserving the newest identity. */
function combineRequests(requests: DispatchRequest[]): DispatchRequest {
  const last = requests[requests.length - 1] as DispatchRequest;
  if (requests.length === 1) return last;
  return {
    ...last,
    text: requests.map((request) => request.text).join("\n")
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
