import { describe, expect, it } from "vitest";
import { performHandoff, resumeHandoff } from "../src/handoff.js";
import { createMemoryState } from "../src/state.js";
import { normalizeChannelConfig } from "../src/types.js";
import { MockChatwoot } from "./helpers.js";

const config = normalizeChannelConfig({
  baseUrl: "https://chatwoot.test",
  accountId: 1,
  apiToken: "tok",
  receptionTeamId: 5,
  handoffNotice: "Connecting you to a teammate.",
  handoffNoteTemplate: "Handoff for {session}. Reason: {reason}"
});

describe("human handoff", () => {
  it("assigns the team, posts a private note, and sends a customer notice", async () => {
    const client = new MockChatwoot();
    const state = createMemoryState();

    const result = await performHandoff({
      client,
      state,
      config,
      conversationId: 10,
      convKey: "chatwoot:1:10",
      reason: "quota"
    });

    expect(result.active).toBe(true);
    expect(client.assignments).toEqual([{ conversationId: 10, teamId: 5 }]);
    expect(client.privateMessages()).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(1);
    expect(client.publicMessages()[0].content).toContain("Connecting you to a teammate.");
    expect(state.isHandoffActive("chatwoot:1:10")).toBe(true);
  });

  it("does not create duplicate notes or notices on retry", async () => {
    const client = new MockChatwoot();
    const state = createMemoryState();
    const deps = { client, state, config, conversationId: 10, convKey: "chatwoot:1:10" };

    await performHandoff(deps);
    await performHandoff(deps);

    expect(client.privateMessages()).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(1);
    expect(client.assignments).toHaveLength(1);
  });

  it("does not duplicate side effects after a restart (state lost, messages persist)", async () => {
    const client = new MockChatwoot();
    const first = createMemoryState();
    await performHandoff({
      client,
      state: first,
      config,
      conversationId: 10,
      convKey: "chatwoot:1:10"
    });

    // Simulate a process restart: fresh in-memory state, same Chatwoot backend.
    const second = createMemoryState();
    await performHandoff({
      client,
      state: second,
      config,
      conversationId: 10,
      convKey: "chatwoot:1:10"
    });

    expect(client.privateMessages()).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(1);
  });

  it("suppresses the customer notice when OpenClaw already replied", async () => {
    const client = new MockChatwoot();
    const state = createMemoryState();
    await performHandoff({
      client,
      state,
      config,
      conversationId: 11,
      convKey: "chatwoot:1:11",
      suppressCustomerNotice: true
    });
    expect(client.privateMessages()).toHaveLength(1);
    expect(client.publicMessages()).toHaveLength(0);
  });

  it("resumes automation on explicit resume", async () => {
    const state = createMemoryState();
    await state.setHandoff("chatwoot:1:10", { active: true, updatedAt: new Date().toISOString() });
    await resumeHandoff(state, "chatwoot:1:10");
    expect(state.isHandoffActive("chatwoot:1:10")).toBe(false);
  });

  it("never writes an internal marker into the customer-visible notice", async () => {
    const client = new MockChatwoot();
    const state = createMemoryState();
    await performHandoff({ client, state, config, conversationId: 14, convKey: "chatwoot:1:14" });
    const visible = client.publicMessages();
    expect(visible).toHaveLength(1);
    expect(visible[0].content).toBe(config.handoffNotice);
    expect(visible[0].content).not.toContain("<!--");
  });
});
