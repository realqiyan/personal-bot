import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentFiles, descriptor, launch, status, cycle } from "../../dist/storage/agent-files.js";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { PiAgents, agentDirectory } from "../../dist/integrations/pi/pi-agents.js";
import { agentOwner, deliveredCycles } from "../../dist/integrations/pi/agent-context.js";
import { packageVersion } from "../../dist/common/version.js";
import { resourceRoot } from "../../dist/common/paths.js";
import { schema } from "../../dist/common/validation.js";
import { agentBoard } from "../../dist/ui/agent-display.js";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { host } from "../helpers/pi-host.mjs";

async function temp(t) { const p = await mkdtemp(join(tmpdir(), "pbot-agents-")); t.after(() => rm(p, { recursive: true, force: true })); return p; }
function saved(files, workspace, owner, options = {}) {
  const agentId = randomUUID(), generation = randomUUID();
  files.create({ agentId, release: packageVersion, workspace, cwd: options.cwd ?? workspace, parentSessionId: owner.sessionId,
    parentLeaf: owner.leaf, createdAt: Date.now(), options }, { generation, name: "research", sequence: 0, stop: false, startedAt: Date.now() });
  return { agentId, generation };
}
const owner = { sessionId: "parent", leaf: "anchor", branch: ["anchor"] };

test("message order, generation, immutable completions and control contention use real files", async t => {
  const root = await temp(t), files = new AgentFiles(join(root, "agents"));
  const { agentId, generation } = saved(files, root, owner);
  const first = files.control(() => files.enqueue(agentId, "one", "steer"));
  const second = files.control(() => files.enqueue(agentId, "two", "followUp"));
  assert.deepEqual(files.messages(agentId).map(m => [m.sequence, m.delivery]), [[1, "steer"], [2, "followUp"]]);
  assert.notEqual(first.requestId, second.requestId);
  files.control(() => assert.throws(() => files.control(() => {})));
  const complete = { cycleId: randomUUID(), generation, startedAt: 1, finishedAt: 2, state: "completed", leaf: null, requestIds: [first.requestId], source: "parent" };
  files.write(agentId, "completions/" + complete.cycleId + ".json", complete, cycle, true);
  assert.throws(() => files.write(agentId, "completions/" + complete.cycleId + ".json", complete, cycle, true));
  const run = files.read(agentId, "launch.json", launch); run.generation = randomUUID(); files.write(agentId, "launch.json", run, launch);
  assert.equal(files.messages(agentId).filter(m => m.generation === run.generation).length, 0);
  assert.equal(files.completions(agentId).length, 1);
  assert.throws(() => files.read("../other", "launch.json", launch));
});

test("stopped history remains readable, enforces branch ownership and never resumes work implicitly", async t => {
  const root = await temp(t), service = new AgentService(root, join(root, "agents"), new PiAgents());
  const { agentId, generation } = saved(service.files, root, owner);
  const manager = SessionManager.create(root, service.files.directory(agentId));
  manager.appendMessage({ role: "user", content: "Historical request", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical answer" }], api: "openai-responses", provider: "openai", model: "historical",
    stopReason: "stop", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await writeFile(service.files.session(agentId), await readFile(manager.getSessionFile()));
  const complete = { cycleId: randomUUID(), generation, startedAt: 1, finishedAt: 2, state: "completed", leaf: manager.getLeafId(), requestIds: [], source: "interactive" };
  service.files.write(agentId, "completions/" + complete.cycleId + ".json", complete, cycle, true);
  service.files.write(agentId, "status.json", { generation, state: "idle", activity: "idle", updatedAt: 2, cycle: complete }, status);
  assert.equal(service.read(agentId, owner).report, "Historical answer");
  assert.equal(service.list(owner)[0].state, "stopped");
  assert.throws(() => service.send(agentId, "new", "steer", owner));
  assert.throws(() => service.read(agentId, { ...owner, branch: [] }));
  assert.throws(() => service.read(agentId, { ...owner, sessionId: "fork" }));
  service.rename(agentId, "renamed", owner); assert.equal(service.list(owner)[0].name, "renamed");
  service.stop(agentId, owner); service.stop(agentId, owner);
  assert.equal(service.read(agentId, owner).report, "Historical answer");
  await service.close(owner);
});

test("a real tmux Pi process with an unavailable model exits without a fake model or replay", { timeout: 30000 }, async t => {
  assert.equal(spawnSync("tmux", ["-V"]).status, 0, "tmux is required for process acceptance");
  const root = await temp(t), service = new AgentService(root, join(root, "agents"), new PiAgents());
  const result = service.start({ message: "No model request", provider: "not-configured", model: "not-configured", noExtensions: true,
    noSkills: true, noContextFiles: true, noPromptTemplates: true }, owner);
  t.after(() => service.close(owner));
  const deadline = Date.now() + 15000;
  while (service.host.alive(result.agentId) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.equal(service.host.alive(result.agentId), false);
  assert.equal(service.completions(owner)[0].cycle.state, "interrupted");
  assert.equal(service.files.messages(result.agentId).length, 1);
  const before = result.generation;
  const resumed = service.resume(result.agentId, "Explicit new request", owner);
  assert.notEqual(resumed.generation, before);
  assert.equal(service.files.completions(result.agentId).find(c => c.generation === before)?.state, "interrupted");
  assert.equal(service.files.messages(result.agentId).filter(m => m.generation === resumed.generation).length, 1);
});

test("agent tool exposes control and report data without replaying launch context or storage identities", { timeout: 30000 }, async t => {
  const directory = await temp(t), prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "config");
  try {
    const { root, session } = await host(t);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    const files = new AgentFiles(agentDirectory()), ctx = session.extensionRunner.createToolContext("local", undefined);
    const options = { message: "Original task", prompts: ["Original context"], provider: "not-configured", model: "not-configured" };
    const identity = saved(files, root, agentOwner(ctx), options);
    const manager = SessionManager.create(root, files.directory(identity.agentId));
    manager.appendMessage({ role: "user", content: options.message, timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical answer" }], api: "openai-responses",
      provider: "openai", model: "historical", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await writeFile(files.session(identity.agentId), await readFile(manager.getSessionFile()));
    const complete = { cycleId: randomUUID(), generation: identity.generation, startedAt: 1, finishedAt: 2, state: "completed",
      leaf: manager.getLeafId(), requestIds: ["request"], source: "interactive" };
    files.write(identity.agentId, "completions/" + complete.cycleId + ".json", complete, cycle, true);
    files.write(identity.agentId, "status.json", { generation: identity.generation, state: "idle", activity: "idle", updatedAt: 2, cycle: complete }, status);
    const tool = session.agent.state.tools.find(tool => tool.name === "pbot_agent");
    const execute = async input => {
      const output = await tool.execute("local", input);
      assert.ok(schema(tool.outputSchema)(output.structuredContent), JSON.stringify(output.structuredContent));
      const views = output.structuredContent.agents ?? [output.structuredContent];
      for (const view of views) {
        for (const field of ["release", "workspace", "generation", "parentSessionId", "parentLeaf", "options"]) assert.equal(Object.hasOwn(view, field), false);
        if (view.cycle) {
          assert.equal(Object.hasOwn(view.cycle, "generation"), false);
          assert.equal(Object.hasOwn(view.cycle, "leaf"), false);
        }
      }
      return output;
    };
    const listed = (await execute({ action: "list" })).structuredContent.agents[0];
    assert.equal(listed.agentId, identity.agentId); assert.equal(listed.owned, true);
    assert.equal(listed.state, "stopped"); assert.equal(listed.cycle.state, "completed");
    assert.equal((await execute({ action: "status", agentId: identity.agentId })).structuredContent.cycle.cycleId, complete.cycleId);
    const first = await execute({ action: "read", agentId: identity.agentId, cycleId: complete.cycleId, limit: 5 });
    assert.equal(first.structuredContent.report, "Histo"); assert.equal(first.structuredContent.nextOffset, 5);
    assert.deepEqual(first.details.agentReadKeys, [identity.agentId + ":" + complete.cycleId]);
    const rest = await execute({ action: "read", agentId: identity.agentId, cycleId: complete.cycleId, offset: 5 });
    assert.equal(rest.structuredContent.report, "rical answer"); assert.equal(rest.structuredContent.nextOffset, null);
    assert.equal((await execute({ action: "rename", agentId: identity.agentId, name: "renamed" })).structuredContent.name, "renamed");
    await execute({ action: "stop", agentId: identity.agentId });
    assert.deepEqual(files.read(identity.agentId, "descriptor.json", descriptor).options, options);
    assert.equal(files.completions(identity.agentId)[0].leaf, complete.leaf);

    const started = (await execute({ action: "start", ...options, noExtensions: true,
      noSkills: true, noContextFiles: true, noPromptTemplates: true })).structuredContent;
    assert.equal(started.messageStatus, "queued");
    assert.equal(files.messages(started.agentId)[0].requestId, started.requestId);
    const agentHost = new PiAgents(), deadline = Date.now() + 15000;
    while (agentHost.alive(started.agentId) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    assert.equal(agentHost.alive(started.agentId), false);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
  }
});

test("activity board includes thinking, startup and stopping, fits narrow terminals, hides idle", () => {
  const theme = loadThemeFromPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url).pathname);
  const values = ["starting", "busy", "stopping", "idle"].map((state, i) => ({ name: "研究🙂".repeat(20), agentId: String(i), state, activity: "thinking", createdAt: Date.now() }));
  for (const width of [1, 10, 80]) {
    const lines = agentBoard(values, theme).render(width);
    assert.equal(lines.length, 3); assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});

test("native parent entries deduplicate completion and only persisted tool results claim reads", async t => {
  const { session } = await host(t), ctx = session.extensionRunner.createToolContext("local", undefined);
  const manager = session.sessionManager;
  const before = manager.getLeafId();
  manager.appendCustomMessageEntry("pbot.agent-results", "complete", true, { keys: ["a:c"] });
  assert.ok(deliveredCycles(ctx).has("a:c"));
  manager.appendCustomEntry("pbot.agent-read", { keys: ["b:c"], toolCallId: "read" });
  assert.equal(deliveredCycles(ctx).has("b:c"), false);
  manager.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "codemode", content: [{ type: "text", text: "read" }], isError: false, timestamp: Date.now() });
  assert.ok(deliveredCycles(ctx).has("b:c"));
  if (before) manager.branch(before); else manager.resetLeaf();
  assert.equal(deliveredCycles(ctx).has("a:c"), false);
});

test("actual child entry uses native tools without provider state or recursive delegation", async t => {
  const { createAgentSession, createMcpExtension, createCodemodeExtension, createToolSearchExtension,
    DefaultResourceLoader, ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { default: childEntry } = await import("../../dist/extension/subagent-entry.js");
  const root = await temp(t);
  const cwd = join(root, "projects/work"); await mkdir(cwd, { recursive: true });
  const files = new AgentFiles(join(root, "agents")), savedRun = saved(files, root, owner, { cwd, noSkills: true, noContextFiles: true }), directory = files.directory(savedRun.agentId);
  const initial = SessionManager.create(cwd, directory); initial.appendMessage({ role: "user", content: "Saved context", timestamp: 1 });
  await writeFile(files.session(savedRun.agentId), await readFile(initial.getSessionFile()));
  const values = { PBOT_SUBAGENT_RUN_ID: savedRun.agentId, PBOT_SUBAGENT_DIR: directory,
    PBOT_SUBAGENT_GENERATION: savedRun.generation, PI_CODING_AGENT_DIR: join(root, "pi-config") };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const agentDir = join(root, "pi-config"); await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [createMcpExtension(), createCodemodeExtension({ models: false }), createToolSearchExtension(), childEntry] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime: runtime,
    resourceLoader: loader, sessionManager: SessionManager.open(files.session(savedRun.agentId)) });
  const errors = []; await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  assert.deepEqual(errors, []);
  assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith("pbot_")), []);
  assert.ok(session.extensionRunner.getRegisteredCommands().some(c => c.name === "mcp"));
  for (const name of ["codemode", "tool_search"]) assert.ok(session.getAllTools().some(t => t.name === name));
  assert.deepEqual(loader.getSkills().skills, []);
  const started = await session.extensionRunner.emitBeforeAgentStart("", undefined, { cwd });
  const environment = JSON.parse(started.systemPromptOptions.sections.pbot_environment);
  assert.equal(environment.workspaceRoot, root); assert.equal(environment.cwd, cwd); assert.equal(environment.resourceRoot, resourceRoot);
  assert.equal(environment.python.state, "error"); assert.equal(typeof environment.python.error, "string");
  const bash = session.agent.state.tools.find(t => t.name === "bash");
  const output = await bash.execute("native", { command: "printf 42" });
  assert.notEqual(output.isError, true);
  assert.equal(output.content.find(p => p.type === "text").text.trim(), "42");
  const denied = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "recursive", toolName: "pbot_agent", input: { action: "list" } });
  assert.equal(denied.block, true);
  assert.equal((await session.extensionRunner.emit({ type: "session_before_switch", reason: "new" })).cancel, true);
});

test("real SDK boundaries defer notifications on abort and persist completion delivery once", async t => {
  const root = await temp(t), prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "config");
  const { session, errors } = await host(t);
  const files = new AgentFiles(agentDirectory());
  try {
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    const ctx = session.extensionRunner.createToolContext("local", undefined);
    const identity = saved(files, ctx.cwd, agentOwner(ctx));
    const complete = { cycleId: randomUUID(), generation: identity.generation, startedAt: 1, finishedAt: 2,
      state: "completed", leaf: null, requestIds: ["request"], source: "parent" };
    files.write(identity.agentId, "completions/" + complete.cycleId + ".json", complete, cycle, true);
    const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
    const boundary = () => session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, drafts => {
      const manager = SessionManager.inMemory(ctx.cwd, undefined,
        [session.sessionManager.getHeader(), ...structuredClone(session.sessionManager.getEntries())]);
      const before = manager.buildSessionProjection().messages.length;
      for (const draft of drafts) manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
      const projection = manager.buildSessionProjection();
      return { contextEntries: projection.entries, contextMessages: projection.messages,
        llmMessages: convertToLlm(projection.messages), pendingMessages: projection.messages.slice(before), canContinue: true };
    });
    assert.equal((await boundary()).continue, false);
    await session.extensionRunner.emitInput("Continue", undefined, "interactive");
    const delivered = await boundary();
    assert.equal(delivered.valid, true); assert.equal(delivered.continue, true);
    assert.deepEqual(delivered.entries[0].details.keys, [identity.agentId + ":" + complete.cycleId]);
    const record = JSON.parse(delivered.entries[0].content.split("\n").at(-1));
    assert.equal(record.agentId, identity.agentId);
    assert.deepEqual(record.cycle, { cycleId: complete.cycleId, state: "completed", source: "parent", requestIds: ["request"] });
    assert.equal(record.report, ""); assert.equal(record.truncated, false);
    for (const entry of delivered.entries) session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    assert.equal((await boundary()).continue, false);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    await rm(files.root, { recursive: true, force: true });
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
  }
});
