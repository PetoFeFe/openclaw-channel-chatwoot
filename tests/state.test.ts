import { mkdtempSync, rmSync } from "node:fs";
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
    await first.setHandoff("chatwoot:1:5", {
      active: true,
      updatedAt: new Date().toISOString(),
      noteSent: true
    });

    const second = DurableState.open({ filePath: file });
    expect(second.isProcessed("msg:1:1")).toBe(true);
    expect(second.getHandoff("chatwoot:1:5")?.active).toBe(true);
    expect(second.getHandoff("chatwoot:1:5")?.noteSent).toBe(true);
  });

  it("tracks pending effects", async () => {
    const state = createMemoryState();
    await state.putEffect("chatwoot:1:5", {
      id: "handoff-note",
      kind: "handoff-note",
      status: "pending",
      attempts: 1,
      updatedAt: new Date().toISOString()
    });
    expect(state.listEffects("chatwoot:1:5")).toHaveLength(1);
    expect(state.pendingConversationKeys()).toEqual(["chatwoot:1:5"]);
    await state.deleteEffect("chatwoot:1:5", "handoff-note");
    expect(state.listEffects("chatwoot:1:5")).toHaveLength(0);
  });

  it("clears a handoff on resume", async () => {
    const state = createMemoryState();
    await state.setHandoff("chatwoot:1:5", { active: true, updatedAt: new Date().toISOString() });
    await state.setHandoff("chatwoot:1:5", undefined);
    expect(state.getHandoff("chatwoot:1:5")).toBeUndefined();
  });
});
