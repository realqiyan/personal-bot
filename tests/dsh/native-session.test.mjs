import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import { openDshAgent, readDshAgentSession, flushDshAgent, readDshReport } from "../../dist/integrations/dsh/session.js";

function descriptor(root, parent) {
  return { agentId: randomUUID(), parentSessionId: parent.id, parentLeaf: null, workspace: root,
    cwd: root, release: "0.2.4", createdAt: Date.now(), options: {} };
}
const unusedSetup = () => {};

test("dsh empty expert is durable across processes without a model or conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-session-"));
  let host;
  try {
    host = await dshHost(join(root, "sessions"));
    const parent = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
    const d = descriptor(root, parent.agent);
    const child = await openDshAgent(host.ctx, d, parent.agent, false, unusedSetup, new AbortController().signal);
    assert.equal(child.agent.status, "idle");
    assert.equal(host.ctx.agents.isOwnedBy(d.agentId, parent.agent), true);
    assert.deepEqual((await readDshAgentSession(host.ctx, d)).events, []);
    // The independent process reads while the live Agent still owns the writer.
    const read = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { dshHost } from ${JSON.stringify(new URL("../helpers/dsh-host.mjs", import.meta.url).href)};
      const host = await dshHost(process.argv[1]);
      try {
        const reader = await host.ctx.sessionPersistence.open(process.argv[2], "read");
        try { console.log(JSON.stringify({ header: reader.header, events: (await reader.read()).events })); }
        finally { await reader.close(); }
      } finally { await host.close(); }
    `, join(root, "sessions"), d.agentId], { encoding: "utf8", timeout: 15000 });
    assert.equal(read.status, 0, read.stderr);
    const stored = JSON.parse(read.stdout);
    assert.equal(stored.header.id, d.agentId);
    assert.deepEqual(stored.events, []);
    await child.dispose();
    assert.equal(host.ctx.agents.get(d.agentId), undefined);
    await readDshAgentSession(host.ctx, d);
    assert.equal(host.ctx.agents.get(d.agentId), undefined);
    await host.close();
    host = await dshHost(join(root, "sessions"));
    const nextParent = await host.ctx.agents.resume({ resumeSessionId: d.parentSessionId });
    const resumed = await openDshAgent(host.ctx, d, nextParent.agent, true, unusedSetup, new AbortController().signal);
    assert.equal(resumed.agent.id, d.agentId);
    assert.equal(resumed.agent.status, "idle");
    assert.equal(resumed.agent.inbox.nextTurn.length, 0);
    await resumed.dispose();
    await nextParent.dispose();
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("dsh resume clears persisted pending input before publication and never drives old work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-resume-"));
  const host = await dshHost(join(root, "sessions"));
  try {
    const parent = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
    const d = descriptor(root, parent.agent);
    const message = createUserMessage({ content: [{ type: "text", text: "unstarted input" }], source: { kind: "user" } });
    // A real failed initialization leaves an unconsumed durable inbox, without publishing or driving an Agent.
    await assert.rejects(host.ctx.agents.create({ sessionId: d.agentId, parentAgent: parent.agent,
      meta: { cwd: d.cwd, parentSession: d.parentSessionId, origin: "subagent" },
      setup(_ctx, agent) { agent.inbox.append("next-turn", message); throw new Error("initialization interrupted"); },
    }), { message: "initialization interrupted" });
    assert.equal(host.ctx.agents.get(d.agentId), undefined);
    assert.ok((await readDshAgentSession(host.ctx, d)).events.some(e => e.type === "agent/inbox/spliced"));
    const child = await openDshAgent(host.ctx, d, parent.agent, true, (_ctx, agent) => {
      assert.deepEqual(agent.inbox.nextTurn, []);
      assert.deepEqual(agent.inbox.nextStep, []);
      assert.equal(host.ctx.agents.get(d.agentId), undefined);
    }, new AbortController().signal);
    await child.agent.whenIdle();
    const events = (await readDshAgentSession(host.ctx, d)).events;
    assert.equal(events.some(e => e.type === "turn/start"), false);
    assert.equal(events.some(e => e.type === "user/message"), false);
    await child.dispose();
    await parent.dispose();
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("dsh report reads stay fixed to a durable turn after later history is appended", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-report-"));
  const host = await dshHost(join(root, "sessions"));
  try {
    const parent = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
    const d = descriptor(root, parent.agent);
    const child = await openDshAgent(host.ctx, d, parent.agent, false, unusedSetup, new AbortController().signal);
    const session = child.agent.session;
    // Native Session API stores history fixtures; no model or provider is invoked.
    const append = (turn, text) => {
      session.append("turn/start", { turn });
      session.append("step/start", { turn, step: 1 });
      session.append("assistant/message", { turn, step: 1,
        message: createAssistantMessage({ content: [{ type: "text", text }], source: { provider: "deepseek-official", model: "deepseek-flash" } }),
        stream: [{ type: "text-chunks", index: 0, time0: Date.now(), dt: [0], texts: [text] }],
      }, { surfaceOp: "append" });
      session.append("step/end", { turn, step: 1 });
      return session.append("turn/end", { turn, reason: { kind: "completed" } }).seq;
    };
    const first = append(1, "original report");
    await flushDshAgent(child.agent);
    assert.equal(await readDshReport(host.ctx, d, "dsh:" + first), "original report");
    const second = append(2, "later report");
    await flushDshAgent(child.agent);
    assert.equal(await readDshReport(host.ctx, d, "dsh:" + first), "original report");
    assert.equal(await readDshReport(host.ctx, d, "dsh:" + second), "later report");
    await assert.rejects(readDshReport(host.ctx, d, "dsh:0"));
    await assert.rejects(readDshReport(host.ctx, d, "dsh:9999"));
    await child.dispose();
    assert.equal(await readDshReport(host.ctx, d, "dsh:" + first), "original report");
    assert.equal(host.ctx.agents.get(d.agentId), undefined);
    await parent.dispose();
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("dsh reads reject wrong ownership and missing records without activating or replacing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-identity-"));
  const host = await dshHost(join(root, "sessions"));
  try {
    const parent = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
    const d = descriptor(root, parent.agent);
    const child = await openDshAgent(host.ctx, d, parent.agent, false, unusedSetup, new AbortController().signal);
    await child.dispose();
    for (const invalid of [{ ...d, cwd: join(root, "other") }, { ...d, parentSessionId: randomUUID() }]) {
      await assert.rejects(readDshAgentSession(host.ctx, invalid));
    }
    const missing = { ...d, agentId: randomUUID() };
    await assert.rejects(openDshAgent(host.ctx, missing, parent.agent, true, unusedSetup, new AbortController().signal));
    assert.equal(host.ctx.agents.get(missing.agentId), undefined);
    assert.equal(await host.ctx.sessionPersistence.stat(missing.agentId), undefined);
    assert.equal(host.ctx.agents.get(d.agentId), undefined);
    await parent.dispose();
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
