import { Spool, spoolKey, type SpoolRecord } from "./spool.js";
import type { Dispatch, DispatchRequest } from "./handler.js";
import type { ChatwootChannelConfig } from "./types.js";
import type { ChatwootConversation, ChatwootMessage } from "./client.js";

/**
 * Background queue worker — the OpenResponses submission model applied to
 * Chatwoot inbound webhooks:
 *
 *   webhook accepts the event into the durable spool, answers HTTP 200, and
 *   NOTHING about agent execution is visible to Chatwoot. A worker drains the
 *   spool asynchronously, one serialized/coalesced lane per conversation, with
 *   internal retries for transient failures (gateway draining, LLM/API errors)
 *   and bounded retries before a record moves to failed/.
 *
 * A reconcile pass treats Chatwoot itself as the source of truth: recent
 * pending conversations are scanned for incoming customer messages the spool
 * never accepted (webhook lost, persistence failure, downtime) and they are
 * enqueued for processing.
 */

export interface QueueLog {
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  error?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ReconcileSource {
  /** Recent conversations for the account (any status; worker filters). */
  listConversations(): Promise<ChatwootConversation[]>;
  listConversationMessages(conversationId: number): Promise<ChatwootMessage[]>;
  getConversation(conversationId: number): Promise<ChatwootConversation>;
}

export interface SpoolQueueOptions {
  spool: Spool;
  config: ChatwootChannelConfig;
  dispatch: Dispatch;
  log?: QueueLog;
  /**
   * Rebuild a DispatchRequest from a persisted record. Provided by index.ts so
   * the queue stays SDK-agnostic; the batch request carries every message of a
   * coalesced burst.
   */
  toRequest: (record: SpoolRecord) => DispatchRequest;
  /** Conversation client used for human-ownership rechecks and reconciliation. */
  client?: ReconcileSource;
  /** Tick interval (ms). Default 1000. */
  tickMs?: number;
  /** Coalescing window (ms). Default 800 (matches the legacy lane). */
  settleMs?: number;
  /** Max dispatch attempts before a record moves to failed/. Default 5. */
  maxAttempts?: number;
  /** Backoff between attempts (ms). Default 2s, 5s, 15s, 45s... */
  retryBackoffMs?: (attempt: number) => number;
  /** Lease duration while a record is being dispatched (ms). Default 5 min. */
  leaseMs?: number;
  /** Reconcile interval (ms). Default 60s; 0 disables. */
  reconcileIntervalMs?: number;
  /** Reconcile only messages/conversations newer than this (s). Default 3600. */
  reconcileLookbackSec?: number;
  now?: () => Date;
  privateNote?: (record: SpoolRecord, reason: string) => Promise<void>;
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gateway is draining|draining for restart|temporar|unavailable|timeout|econn|socket/i.test(
    message
  );
}

export class SpoolQueue {
  private readonly opts: Required<Pick<SpoolQueueOptions, "tickMs" | "settleMs" | "maxAttempts">> &
    SpoolQueueOptions;
  private readonly log: QueueLog;
  private timer?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private loopPromise?: Promise<void>;
  private wakeFn?: () => void;
  /** Conversations with a dispatch in flight (per-process serialization). */
  private readonly activeConvs = new Set<string>();

  constructor(options: SpoolQueueOptions) {
    this.opts = {
      tickMs: options.tickMs ?? 1000,
      settleMs: options.settleMs ?? 800,
      maxAttempts: options.maxAttempts ?? 5,
      ...options
    };
    this.log = options.log ?? {};
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.opts.spool.init();
    await this.opts.spool.recover(this.nowIso());
    this.loopPromise = this.loop();
    if ((this.opts.reconcileIntervalMs ?? 60_000) > 0 && this.opts.client) {
      this.scheduleReconcile((this.opts.reconcileIntervalMs ?? 60_000) / 2);
    }
  }

  stop(): void {
    this.running = false;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.wakeFn?.();
  }

  /** Trigger a tick as soon as possible (called after each accepted webhook). */
  wake(): void {
    this.wakeFn?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tickOnce();
      } catch (error) {
        this.log.error?.("chatwoot: queue tick failed", { error: String(error) });
      }
      const due = await this.hasDueRecords();
      await this.sleep(due ? 0 : this.opts.tickMs ?? 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) return resolve();
      const timer = setTimeout(() => {
        this.wakeFn = undefined;
        resolve();
      }, ms);
      this.wakeFn = () => {
        clearTimeout(timer);
        this.wakeFn = undefined;
        resolve();
      };
    });
  }

  private scheduleReconcile(delayMs: number): void {
    if (!this.running || this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcileTick();
    }, delayMs);
  }

  private async reconcileTick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.reconcile();
    } catch (error) {
      this.log.warn?.("chatwoot: reconcile pass failed", { error: String(error) });
    } finally {
      this.scheduleReconcile(this.opts.reconcileIntervalMs ?? 60_000);
    }
  }

  /** Drain due records once, grouped by conversation. */
  async tickOnce(): Promise<void> {
    const spool = this.opts.spool;
    await spool.recover(this.nowIso());
    await spool.pruneCompleted(this.shiftIso(-24 * 3600_000));
    const dueBefore = new Date(this.now().getTime() - this.opts.settleMs).toISOString();
    const inbox = await spool.list("inbox");
    const byConv = new Map<string, SpoolRecord[]>();
    for (const record of inbox.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
      if (record.availableAt > dueBefore) continue;
      if (this.activeConvs.has(convKeyOf(record))) continue;
      const list = byConv.get(convKeyOf(record)) ?? [];
      list.push(record);
      byConv.set(convKeyOf(record), list);
    }
    const batches = [...byConv.values()];
    await Promise.all(batches.map((records) => this.processConversation(records)));
  }

  /** True when at least one inbox record is past its settle window. */
  private async hasDueRecords(): Promise<boolean> {
    const dueBefore = new Date(this.now().getTime() - this.opts.settleMs).toISOString();
    const inbox = await this.opts.spool.list("inbox");
    return inbox.some(
      (record) => record.availableAt <= dueBefore && !this.activeConvs.has(convKeyOf(record))
    );
  }

  private shiftIso(deltaMs: number): string {
    return new Date(this.now().getTime() + deltaMs).toISOString();
  }

  /** Process one conversation's due records as a single ordered batch. */
  private async processConversation(records: SpoolRecord[]): Promise<void> {
    const key = convKeyOf(records[0] as SpoolRecord);
    if (this.activeConvs.has(key)) return;
    this.activeConvs.add(key);
    const spool = this.opts.spool;
    try {
      const claimed: SpoolRecord[] = [];
      for (const record of records) {
        const got = await spool.claim(record, this.shiftIso(this.opts.leaseMs ?? 300_000));
        if (got) claimed.push(got);
      }
      if (claimed.length === 0) return;

      // Redelivery protection: a record claimed more than once means a
      // previous dispatch ended without a recorded completion (crash before
      // complete). If Chatwoot already shows a bot reply newer than the
      // newest queued message, that reply landed — complete without answering
      // again. (The agent owns the human-handoff silence decision; the plugin
      // does not filter on conversation status.)
      const redelivered = claimed.some((record) => (record.claims ?? 0) >= 2);
      if (redelivered && this.opts.client) {
        const answered = await this.alreadyAnswered(claimed);
        if (answered) {
          for (const record of claimed) await spool.complete(record);
          this.log.info?.("chatwoot: batch already answered; skipping re-dispatch", {
            convKey: key,
            messages: claimed.map((record) => record.messageId)
          });
          return;
        }
      }

      const batch = this.opts.toRequest(claimed[claimed.length - 1] as SpoolRecord);
      if (claimed.length > 1) {
        batch.text = claimed.map((record) => record.text).join("\n");
      }
      // Pass the live conversation status to the agent: the agent decides
      // whether a human owns the conversation and must stay silent.
      const live = await this.currentStatus(claimed[0] as SpoolRecord);
      if (live) batch.status = live;
      const attemptStart = Math.max(...claimed.map((record) => record.attempt));
      try {
        await this.opts.dispatch(batch);
        for (const record of claimed) await spool.complete(record);
        this.log.info?.("chatwoot: queue batch dispatched", {
          convKey: key,
          messages: claimed.map((record) => record.messageId)
        });
      } catch (error) {
        const attempt = attemptStart + 1;
        const transient = isTransientError(error);
        this.log.warn?.("chatwoot: queue dispatch attempt failed", {
          convKey: key,
          attempt,
          transient,
          error: error instanceof Error ? error.message : String(error)
        });
        for (const record of claimed) {
          if (attempt >= this.opts.maxAttempts) {
            await spool.fail(record, String(error));
            this.log.error?.("chatwoot: queue dispatch exhausted retries", {
              convKey: key,
              messageId: record.messageId
            });
            await this.onPermanentFailure(record, key);
          } else if (transient) {
            // Keep the lease window; recover() requeues abandoned records. The
            // retry timer below re-triggers a tick; record stays processing
            // until then is NOT acceptable — requeue with availableAt instead.
            const backoffMs =
              (this.opts.retryBackoffMs ?? defaultBackoff)(attempt);
            await spool.requeue(record, {
              attempt,
              availableAt: this.shiftIso(backoffMs),
              lastError: String(error)
            });
          } else {
            await spool.fail(record, String(error));
            await this.onPermanentFailure(record, key);
          }
        }
      }
    } finally {
      this.activeConvs.delete(key);
    }
  }

  private async onPermanentFailure(record: SpoolRecord, key: string): Promise<void> {
    // Default safe action: an internal private note (Tata's own outbound path
    // is never taken by the plugin). Opening the conversation to humans is a
    // deployment opt-in.
    if (this.opts.privateNote) {
      try {
        await this.opts.privateNote(record, `dispatch retries exhausted (${key})`);
      } catch (error) {
        this.log.warn?.("chatwoot: permanent-failure note could not be sent", {
          error: String(error)
        });
      }
    }
  }

  private async currentStatus(record: SpoolRecord): Promise<string | undefined> {
    if (!this.opts.client) return undefined;
    try {
      const conv = await this.opts.client.getConversation(Number(record.conversationId));
      return conv?.status;
    } catch (error) {
      this.log.warn?.("chatwoot: conversation status recheck failed", { error: String(error) });
      return undefined;
    }
  }

  /**
   * True when Chatwoot already shows a non-private bot reply newer than the
   * newest queued customer message: the previous dispatch landed, so the batch
   * must not be re-run (exactly-once across crash/reconcile/retry).
   */
  private async alreadyAnswered(records: readonly SpoolRecord[]): Promise<boolean> {
    if (!this.opts.client) return false;
    const conversationId = Number(records[0]?.conversationId);
    if (!Number.isFinite(conversationId)) return false;
    const maxMsg = Math.max(
      ...records.map((record) => record.messageId ?? 0),
      0
    );
    try {
      const messages = await this.opts.client.listConversationMessages(conversationId);
      return messages.some((message) => {
        const outgoing = message.message_type === 1 || message.message_type === "outgoing";
        return outgoing && message.private !== true && message.id > maxMsg;
      });
    } catch (error) {
      this.log.warn?.("chatwoot: already-answered check failed; dispatching", {
        error: String(error)
      });
      return false;
    }
  }

  /**
   * Reconcile: find incoming customer messages in recent pending bot-inbox
   * conversations that the spool never accepted (webhook lost during downtime,
   * persistence failure) and enqueue them. Only messages newer than
   * `reconcileLookbackSec` are considered, so a first run never re-dispatches
   * historical traffic.
   */
  async reconcile(): Promise<void> {
    const client = this.opts.client;
    const spool = this.opts.spool;
    if (!client) return;
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const lookback = this.opts.reconcileLookbackSec ?? 3600;
    const cutoff = nowSec - lookback;
    const conversations = await client.listConversations();
    const botInboxes = new Set((this.opts.config.botInboxIds ?? []).map(String));
    for (const conv of conversations) {
      if (conv.status !== "pending") continue;
      if (botInboxes.size > 0 && conv.inbox_id !== undefined && !botInboxes.has(String(conv.inbox_id))) {
        continue;
      }
      if (conv.last_activity_at !== undefined && conv.last_activity_at < cutoff) continue;
      const messages = await client.listConversationMessages(conv.id);
      let recovered = 0;
      for (const message of messages) {
        const incoming = message.message_type === 0 || message.message_type === "incoming";
        if (!incoming || message.private === true) continue;
        const selfSent = message.sender?.type === "agent" || message.sender?.type === "bot";
        const text = typeof message.content === "string" ? message.content.trim() : "";
        if (!text || selfSent) continue;
        const createdAt = toEpochSec(message.created_at);
        if (createdAt !== undefined && createdAt < cutoff) continue;
        const key = spoolKey(String(this.opts.config.accountId), message.id);
        if (await spool.hasKey(key)) continue;
        const now = this.now();
        await spool.accept({
          key,
          accountId: String(this.opts.config.accountId),
          conversationId: String(conv.id),
          inboxId: conv.inbox_id !== undefined ? String(conv.inbox_id) : undefined,
          messageId: message.id,
          text,
          senderId: message.sender?.id !== undefined ? String(message.sender.id) : undefined,
          statusAtReceipt: conv.status,
          receivedAt: now.toISOString(),
          availableAt: now.toISOString(),
          attempt: 0,
          source: "reconcile",
          payload: {
            event: "message_created",
            id: message.id,
            content: text,
            message_type: "incoming",
            private: false,
            account: { id: Number(this.opts.config.accountId) },
            conversation: { id: conv.id, status: conv.status, inbox_id: conv.inbox_id },
            inbox: { id: conv.inbox_id },
            sender: { id: message.sender?.id, type: "contact" },
            reconciled: true
          }
        });
        recovered += 1;
        this.log.info?.("chatwoot: reconcile recovered message", {
          accountId: this.opts.config.accountId,
          conversationId: conv.id,
          messageId: message.id
        });
      }
      if (recovered > 0) this.wake();
    }
  }
}

function toEpochSec(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Chatwoot webhooks use unix seconds; message rows can be ISO strings.
    return value > 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  }
  return undefined;
}

function convKeyOf(record: SpoolRecord): string {
  return `${record.accountId}:${record.conversationId}`;
}

function defaultBackoff(attempt: number): number {
  return Math.min(45_000, 2_000 * 2 ** (attempt - 1));
}
