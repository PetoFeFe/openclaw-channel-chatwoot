import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable filesystem spool for accepted inbound events (no SQLite).
 *
 * Mirrors the OpenResponses submission model: the webhook handler persists a
 * record atomically, answers HTTP 200, and a background worker drains the
 * spool later. Records move through four directories:
 *
 *   inbox/       accepted, waiting for (or inside) their coalescing window
 *   processing/  claimed by the worker, protected by a lease timestamp
 *   completed/   dispatched successfully (pruned after a retention window)
 *   failed/      retries exhausted; kept for operators/replay
 *
 * Durability comes from write-to-temp + rename (atomic on the same volume)
 * and from the directory moves themselves; a crash at any point leaves the
 * record in exactly one place (orphan duplicates are resolved on scan).
 */

export interface SpoolRecord {
  /** Idempotency key: "<account>:<messageId>". */
  key: string;
  accountId: string;
  conversationId: string;
  inboxId?: string;
  messageId?: number;
  text: string;
  senderId?: string;
  /** Conversation status reported by Chatwoot when the event was received. */
  statusAtReceipt?: string;
  /** ISO timestamp when the event was accepted (arrival order). */
  receivedAt: string;
  /** ISO timestamp before which the worker must not claim it (coalescing). */
  availableAt: string;
  /** Dispatch attempts already made (excludes human-owned requeues). */
  attempt: number;
  /**
   * How many times this record has ever been claimed. claims>=2 means a
   * previous claim ended without a recorded completion (crash between dispatch
   * and complete, or a retried failure) — only then may the already-answered
   * shortcut skip the batch.
   */
  claims?: number;
  /** Audio/voice attachments worth transcribing (Chatwoot data_url form). */
  audioAttachments?: Array<Record<string, unknown>>;
  /** ISO deadline after which a processing record is considered abandoned. */
  leaseUntil?: string;
  lastError?: string;
  source: "webhook" | "reconcile";
  /**
   * Raw webhook payload (the parsed event). Kept so the worker can rebuild a
   * full DispatchRequest with the same fidelity as a live webhook.
   */
  payload: Record<string, unknown>;
}

export type SpoolDir = "inbox" | "processing" | "completed" | "failed";

export interface SpoolOptions {
  rootDir: string;
}

function fileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function keyFromFileName(name: string): string {
  return name.slice(0, -".json".length);
}

export class Spool {
  private readonly root: string;

  constructor(options: SpoolOptions) {
    this.root = options.rootDir;
  }

  dir(dir: SpoolDir): string {
    return join(this.root, dir);
  }

  private pathFor(dir: SpoolDir, key: string): string {
    return join(this.dir(dir), fileName(key));
  }

  /** Ensure all spool directories exist (idempotent). */
  async init(): Promise<void> {
    for (const d of ["inbox", "processing", "completed", "failed"] as SpoolDir[]) {
      await mkdir(this.dir(d), { recursive: true });
    }
  }

  /** In-process guard so two concurrent webhook tasks for the same key
   *  cannot both pass the async hasKey check. */
  private readonly inFlight = new Set<string>();

  /**
   * Persist a freshly accepted record. Returns false when the key is already
   * present in any directory (duplicate webhook delivery) — the caller then
   * answers HTTP 200 with action=duplicate.
   */
  async accept(record: SpoolRecord): Promise<boolean> {
    if (this.inFlight.has(record.key)) return false;
    this.inFlight.add(record.key);
    try {
      if (await this.hasKey(record.key)) return false;
      const target = this.pathFor("inbox", record.key);
      const tmp = `${target}.tmp`;
      await mkdir(this.dir("inbox"), { recursive: true });
      await writeFile(tmp, JSON.stringify(record));
      await rename(tmp, target);
      return true;
    } finally {
      this.inFlight.delete(record.key);
      await unlink(`${this.pathFor("inbox", record.key)}.tmp`).catch(() => {});
    }
  }

  /** True when the key exists in inbox/processing/completed/failed. */
  async hasKey(key: string): Promise<boolean> {
    for (const d of ["inbox", "processing", "completed", "failed"] as SpoolDir[]) {
      try {
        await readFile(this.pathFor(d, key));
        return true;
      } catch {
        /* try next dir */
      }
    }
    return false;
  }

  /** All records in a directory (unordered; callers sort). */
  async list(dir: SpoolDir): Promise<SpoolRecord[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try {
      names = await readdir(this.dir(dir));
    } catch {
      return [];
    }
    const records: SpoolRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(dir, keyFromFileName(name));
      if (record) records.push(record);
    }
    return records;
  }

  async read(dir: SpoolDir, key: string): Promise<SpoolRecord | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(dir, key), "utf8")) as SpoolRecord;
    } catch {
      return null;
    }
  }

  private async write(dir: SpoolDir, record: SpoolRecord): Promise<void> {
    const target = this.pathFor(dir, record.key);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, target);
  }

  /**
   * Claim a record for dispatch: atomically move inbox -> processing.
   * Returns false when the inbox copy is already gone (another claim won).
   * The lease deadline is patched in after the move; recovery treats a
   * missing/expired lease as abandoned, so a crash between move and patch
   * is safe.
   */
  async claim(record: SpoolRecord, leaseUntil: string): Promise<SpoolRecord | null> {
    try {
      await rename(this.pathFor("inbox", record.key), this.pathFor("processing", record.key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    const claimed: SpoolRecord = {
      ...record,
      leaseUntil,
      claims: (record.claims ?? 0) + 1
    };
    await this.write("processing", claimed).catch(() => {
      /* lease patch is best-effort; recovery requeues on expiry */
    });
    return claimed;
  }

  /** Move a claimed record to completed/. Unlinking first guarantees a
   *  duplicate can never coexist; the audit copy is best-effort. */
  async complete(record: SpoolRecord): Promise<void> {
    await unlink(this.pathFor("processing", record.key)).catch(() => {});
    await this.write("completed", record).catch(() => {});
  }

  /** Move a claimed record to failed/ (retries exhausted). */
  async fail(record: SpoolRecord, reason: string): Promise<void> {
    await unlink(this.pathFor("processing", record.key)).catch(() => {});
    await this.write("failed", { ...record, leaseUntil: undefined, lastError: reason });
  }

  /** Return a claimed record to inbox/ for a later attempt. */
  async requeue(record: SpoolRecord, next: Partial<SpoolRecord>): Promise<void> {
    const merged = { ...record, ...next, leaseUntil: undefined };
    await unlink(this.pathFor("inbox", record.key)).catch(() => {});
    try {
      await rename(this.pathFor("processing", record.key), this.pathFor("inbox", record.key));
    } catch {
      await this.write("inbox", merged);
      await unlink(this.pathFor("processing", record.key)).catch(() => {});
      return;
    }
    await this.write("inbox", merged);
  }

  /**
   * Resolve crash artifacts before scanning:
   *  - key present in processing/ wins: drop the inbox duplicate;
   *  - processing record with missing/expired lease returns to inbox
   *    (attempt counter preserved).
   *
   * With `ignoreLeases` (used at STARTUP) every processing record returns to
   * inbox: a fresh process owns the whole state directory, so a live lease can
   * only belong to a dispatch that died with the previous process.
   */
  async recover(nowIso: string, opts: { ignoreLeases?: boolean } = {}): Promise<void> {
    const inbox = await this.list("inbox");
    for (const record of inbox) {
      const claimed = await this.read("processing", record.key);
      if (claimed) {
        // processing/ is authoritative; the inbox copy is a crash duplicate.
        await unlink(this.pathFor("inbox", record.key)).catch(() => {});
      }
    }
    const processing = await this.list("processing");
    for (const record of processing) {
      // During runtime only requeue abandoned leases (missing/expired): a
      // live lease means a dispatch is in flight. At startup ignoreLeases is
      // set and every stale claim is reclaimed.
      if (!opts.ignoreLeases && record.leaseUntil && record.leaseUntil > nowIso) continue;
      await this.requeue(record, {});
    }
  }

  /** Delete completed records older than the retention window. */
  async pruneCompleted(beforeIso: string): Promise<void> {
    for (const record of await this.list("completed")) {
      if (record.receivedAt < beforeIso) {
        await unlink(this.pathFor("completed", record.key)).catch(() => {});
      }
    }
  }
}

export function spoolKey(accountId: string | number, messageId: string | number): string {
  return `${String(accountId)}:${String(messageId)}`;
}
