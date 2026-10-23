import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable plugin state.
 *
 * Tracks processed webhook keys (delivery ids and Chatwoot message ids) so a
 * redelivered webhook can never start a second agent turn.
 *
 * Persistence is an atomic JSON file write (temp file + rename). Tests can use
 * the in-memory variant via createMemoryState().
 */

interface StateData {
  processed: Record<string, string>;
}

function emptyState(): StateData {
  return { processed: {} };
}

function readProcessed(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const processed: Record<string, string> = {};
  for (const [key, at] of Object.entries(value)) {
    if (typeof at === "string") processed[key] = at;
  }
  return processed;
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
        const parsed = JSON.parse(readFileSync(options.filePath, "utf8")) as {
          processed?: unknown;
        };
        store.data = { processed: readProcessed(parsed?.processed) };
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

  /**
   * Atomically claim a key for processing.
   *
   * The in-memory write happens synchronously (before the first await), so two
   * concurrent webhook deliveries for the same key cannot both observe an
   * unclaimed key and both dispatch. Returns false when the key was already
   * claimed.
   */
  async claimProcessed(key: string, at: string = new Date().toISOString()): Promise<boolean> {
    if (Object.prototype.hasOwnProperty.call(this.data.processed, key)) return false;
    this.data.processed[key] = at;
    await this.persist();
    return true;
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
