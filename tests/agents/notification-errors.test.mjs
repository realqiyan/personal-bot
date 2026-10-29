import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { AgentFiles, cycle } from "../../dist/storage/agent-files.js";
import { TeamFiles } from "../../dist/storage/team-files.js";
import { agentDirectory } from "../../dist/integrations/pi/pi-agents.js";
import { agentOwner } from "../../dist/integrations/pi/agent-context.js";
import { packageVersion } from "../../dist/common/version.js";
import { host } from "../helpers/pi-host.mjs";

function preview(session, entries) {
  const manager = SessionManager.inMemory(session.sessionManager.getCwd(), undefined,
    [session.sessionManager.getHeader(), ...structuredClone(session.sessionManager.getEntries())]);
  const before = manager.buildSessionProjection().messages.length;
  for (const entry of entries) manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  const projection = manager.buildSessionProjection();
  return { contextEntries: projection.entries, contextMessages: projection.messages,
    llmMessages: convertToLlm(projection.messages), pendingMessages: projection.messages.slice(before), canContinue: true };
}

test("unreadable completion reports reach the model once and respect abort", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-notification-error-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const { session, errors } = await host(t);
  const files = new AgentFiles(agentDirectory());
  try {
    await session.extensionRunner.emit({ type: "session_tree" });
    await mkdir(join(files.root, ".control"));
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    const owner = agentOwner(session.extensionRunner.createToolContext("local", undefined));
    const agentId = randomUUID(), generation = randomUUID(), cycleId = randomUUID();
    files.create({ agentId, release: packageVersion, workspace: session.sessionManager.getCwd(), cwd: session.sessionManager.getCwd(),
      parentSessionId: owner.sessionId, parentLeaf: owner.leaf, createdAt: 1, options: {} },
    { generation, name: "report", sequence: 1, stop: true, startedAt: 1 });
    files.bindSession(agentId, join(root, "missing.jsonl"));
    files.write(agentId, "completions/" + cycleId + ".json", { cycleId, generation, startedAt: 1,
      finishedAt: 2, state: "completed", leaf: "missing-leaf", requestIds: ["request"], source: "parent" }, cycle, true);
    const boundary = () => session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, entries => preview(session, entries));
    assert.equal((await boundary()).continue, false);
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const result = await boundary();
    assert.equal(result.valid, true);
    assert.equal(result.continue, true);
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.customType, "pbot.agent-error");
    assert.equal(entry.details.keys.length, 1);
    assert.equal(convertToLlm([{ role: "custom", ...entry, timestamp: 1 }])[0].role, "user");
    session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    await session.extensionRunner.emit({ type: "session_tree" });
    assert.equal((await boundary()).continue, false);
    await session.extensionRunner.emit({ type: "session_tree" });
    assert.equal((await boundary()).entries.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await rm(files.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a persistent control lock delaying pause is reported after input resumes and clears on recovery", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-pause-error-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const { session, errors } = await host(t);
  const lock = join(agentDirectory(), ".control");
  const boundary = () => session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, entries => preview(session, entries));
  try {
    await mkdir(lock);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    assert.equal((await boundary()).entries.length, 0);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    // Use the real scanner and clock; a blocked pause must not hide sustained contention.
    await new Promise(resolve => setTimeout(resolve, 5500));
    await session.extensionRunner.emit({ type: "session_tree" });
    assert.equal((await boundary()).continue, false);
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const notice = await boundary();
    assert.equal(notice.valid, true); assert.equal(notice.continue, true);
    assert.equal(notice.entries.length, 1);
    const entry = notice.entries[0];
    assert.equal(entry.customType, "pbot.agent-error");
    session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    assert.equal((await boundary()).entries.length, 0);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await rm(lock, { recursive: true });
    const files = new AgentFiles(agentDirectory()), ctx = session.extensionRunner.createToolContext("local", undefined);
    const owner = agentOwner(ctx), agentId = randomUUID(), generation = randomUUID(), cycleId = randomUUID();
    files.create({ agentId, release: packageVersion, workspace: ctx.cwd, cwd: ctx.cwd,
      parentSessionId: owner.sessionId, parentLeaf: owner.leaf, createdAt: 1, options: {} },
    { generation, name: "stopped", sequence: 0, stop: true, startedAt: 1 });
    files.write(agentId, "completions/" + cycleId + ".json", { cycleId, generation, startedAt: 1, finishedAt: 2,
      state: "interrupted", leaf: null, requestIds: [], source: "parent" }, cycle, true);
    await session.extensionRunner.emit({ type: "session_tree" });
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const recovered = await boundary();
    assert.equal(recovered.continue, true); assert.equal(recovered.entries.length, 1);
    assert.equal(recovered.entries[0].customType, "pbot.agent-results");
    assert.deepEqual(recovered.entries[0].details.keys, [agentId + ":" + cycleId]);
    const team = session.agent.state.tools.find(tool => tool.name === "pbot_team");
    assert.deepEqual((await team.execute("list", { action: "list" })).structuredContent.teams, []);
    assert.deepEqual(errors, []);
  } finally {
    await rm(lock, { recursive: true, force: true });
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a delivered read failure is reported again when the service requires reload", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-reload-error-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const { session, errors } = await host(t);
  const files = new AgentFiles(agentDirectory()), lock = join(files.root, ".control");
  const broken = join(new TeamFiles(files).root, "unreadable");
  const boundary = () => session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, entries => preview(session, entries));
  try {
    await mkdir(lock);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "team.json"), "{");
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const first = await boundary(), entry = first.entries[0];
    assert.equal(first.valid, true); assert.equal(first.continue, true);
    assert.equal(entry.customType, "pbot.agent-error");
    session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    assert.equal((await boundary()).entries.length, 0);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await rm(lock, { recursive: true });
    // The scanner now reaches the damaged record and disables this service instance.
    await session.extensionRunner.emit({ type: "session_tree" });
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const second = await boundary(), escalated = second.entries[0];
    assert.equal(second.valid, true); assert.equal(second.continue, true);
    assert.equal(escalated.customType, "pbot.agent-error");
    assert.notDeepEqual(escalated.details.keys, entry.details.keys);
    session.sessionManager.appendCustomMessageEntry(escalated.customType, escalated.content, escalated.display, escalated.details);
    assert.equal((await boundary()).entries.length, 0);
    // Restoring readable storage does not revive the failed instance; native reload does.
    await rename(broken, join(root, "unreadable-team"));
    await session.extensionRunner.emit({ type: "session_tree" });
    assert.equal((await boundary()).entries.length, 0);
    const team = session.agent.state.tools.find(tool => tool.name === "pbot_team");
    await assert.rejects(team.execute("list", { action: "list" }));
    assert.deepEqual(errors, []);
    await session.reload();
    await assert.rejects(team.execute("stale", { action: "list" }));
    const reloaded = session.agent.state.tools.find(tool => tool.name === "pbot_team");
    assert.deepEqual((await reloaded.execute("list", { action: "list" })).structuredContent.teams, []);
    assert.equal((await boundary()).entries.length, 0);
    assert.deepEqual(errors.map(error => error.event), ["session_shutdown"]);
  } finally {
    await rm(lock, { recursive: true, force: true });
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
