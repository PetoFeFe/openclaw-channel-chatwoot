import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable plugin state.
 *
 * Tracks:
 *  - processed inbound message ids (webhook deduplication)
 *  - handoff status per conversation (auto-reply suppression + resume)
 *  - pending side effects (assign/note/notice) so retries and restarts do not
 *    create duplicate messages or notes.
 *
 * Persistence is an atomic JSON file write (temp file + rename). Tests can use
 * the in-memory variant via createMemoryState().
 */

export interface HandoffState {
  active: boolean;
  teamId?: string;
  reason?: string;
  updatedAt: string;
  assigned?: boolean;
  noteSent?: boolean;
  customerNoticeSent?: boolean;
}

export interface PendingEffect {
  id: string;
  kind: "assign-team" | "handoff-note" | "customer-notice" | string;
  status: "pending" | "done";
  attempts: number;
  result?: unknown;
  updatedAt: string;
}

interface StateData {
  processed: Record<string, string>;
  handoffs: Record<string, HandoffState>;
  effects: Record<string, Record<string, PendingEffect>>;
}

function emptyState(): StateData {
  return { processed: {}, handoffs: {}, effects: {} };
}

export interface DurableStateOptions {
  /** Absolute path to the JSON state file. When omitted the store is in-memory. */
  filePath?: string;
}

export class DurableState {
  private data: StateData = emptyState();
  private readonly filePath?: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: DurableStateOptions = {}) {
    this.filePath = options.filePath;
  }

  /** Load state from disk if a file exists. */
  static open(options: DurableStateOptions = {}): DurableState {
    const store = new DurableState(options);
    if (options.filePath && existsSync(options.filePath)) {
      try {
        store.data = { ...emptyState(), ...JSON.parse(readFileSync(options.filePath, "utf8")) };
      } catch (error) {
        throw new Error(
          `chatwoot: failed to read state file ${options.filePath}: ${(error as Error).message}`
        );
      }
    }
    return store;
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const snapshot = JSON.stringify(this.data);
    this.saveChain = this.saveChain.then(() => {
      const dir = dirname(this.filePath as string);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, snapshot, "utf8");
      renameSync(tmp, this.filePath as string);
    });
    return this.saveChain;
  }

  // ---- processed events (dedupe) ----

  isProcessed(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.processed, key);
  }

  async markProcessed(key: string, at: string = new Date().toISOString()): Promise<void> {
    this.data.processed[key] = at;
    await this.persist();
  }

  // ---- handoff status ----

  getHandoff(convKey: string): HandoffState | undefined {
    return this.data.handoffs[convKey];
  }

  isHandoffActive(convKey: string): boolean {
    return this.data.handoffs[convKey]?.active === true;
  }

  async setHandoff(convKey: string, state: HandoffState | undefined): Promise<void> {
    if (state === undefined) delete this.data.handoffs[convKey];
    else this.data.handoffs[convKey] = state;
    await this.persist();
  }

  // ---- pending effects ----

  getEffect(convKey: string, effectId: string): PendingEffect | undefined {
    return this.data.effects[convKey]?.[effectId];
  }

  listEffects(convKey: string): PendingEffect[] {
    return Object.values(this.data.effects[convKey] ?? {});
  }

  /** Conversation keys that have at least one recorded effect. */
  pendingConversationKeys(): string[] {
    return Object.keys(this.data.effects);
  }

  /** All known conversation keys (handoff records + effects). */
  knownConversationKeys(): string[] {
    return Array.from(new Set([...Object.keys(this.data.handoffs), ...Object.keys(this.data.effects)]));
  }

  async putEffect(convKey: string, effect: PendingEffect): Promise<void> {
    const bucket = (this.data.effects[convKey] ??= {});
    bucket[effect.id] = effect;
    await this.persist();
  }

  async deleteEffect(convKey: string, effectId: string): Promise<void> {
    if (this.data.effects[convKey]) {
      delete this.data.effects[convKey][effectId];
      await this.persist();
    }
  }

  /** Flush pending writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.persist();
  }
}

/** In-memory store for tests. */
export function createMemoryState(): DurableState {
  return new DurableState();
}
