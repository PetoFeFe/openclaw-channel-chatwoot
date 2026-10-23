import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryState, DurableState } from "../src/state.js";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "chatwoot-state-"));
  dirs.push(dir);
  return join(dir, "state.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable state", () => {
  it("records processed events for deduplication", async () => {
    const state = createMemoryState();
    expect(state.isProcessed("msg:1:1")).toBe(false);
    await state.markProcessed("msg:1:1");
    expect(state.isProcessed("msg:1:1")).toBe(true);
  });

  it("atomically claims a key exactly once", async () => {
    const state = createMemoryState();
    // Two concurrent claims: exactly one wins.
    const [a, b] = await Promise.all([
      state.claimProcessed("msg:1:7"),
      state.claimProcessed("msg:1:7")
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await expect(state.claimProcessed("msg:1:7")).resolves.toBe(false);
  });

  it("persists processed events across a restart", async () => {
    const file = tempFile();
    const first = DurableState.open({ filePath: file });
    await first.markProcessed("msg:1:1");
    await first.markProcessed("delivery:abc");

    const second = DurableState.open({ filePath: file });
    expect(second.isProcessed("msg:1:1")).toBe(true);
    expect(second.isProcessed("delivery:abc")).toBe(true);
  });

  it("ignores legacy handoff/effect keys in an existing state file", async () => {
    const file = tempFile();
    const first = DurableState.open({ filePath: file });
    await first.markProcessed("msg:1:9");

    const legacy = JSON.parse(readFileSync(file, "utf8"));
    legacy.handoffs = { "chatwoot:1:5": { active: true, updatedAt: "2026-01-01T00:00:00.000Z" } };
    legacy.effects = { "chatwoot:1:5": { note: { id: "note", kind: "handoff-note", status: "done", attempts: 1, updatedAt: "2026-01-01T00:00:00.000Z" } } };
    writeFileSync(file, JSON.stringify(legacy), "utf8");

    const second = DurableState.open({ filePath: file });
    expect(second.isProcessed("msg:1:9")).toBe(true);
  });
});
