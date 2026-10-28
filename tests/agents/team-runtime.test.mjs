import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager, DefaultResourceLoader, createAgentSession, ModelRuntime, SettingsManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { AgentFiles, status, cycle } from "../../dist/storage/agent-files.js";
import { TeamFiles } from "../../dist/storage/team-files.js";
import { TeamService } from "../../dist/services/agents/team-service.js";
import { teamContext, deliveredTeams } from "../../dist/integrations/pi/team-context.js";
import { agentOwner } from "../../dist/integrations/pi/agent-context.js";
import { agentDirectory } from "../../dist/integrations/pi/pi-agents.js";
import { schema } from "../../dist/common/validation.js";
import { packageVersion } from "../../dist/common/version.js";
import childEntry from "../../dist/extension/subagent-entry.js";
import { host } from "../helpers/pi-host.mjs";

function boundaryPreview(session, entries) {
  const manager = SessionManager.inMemory(session.cwd, undefined, [session.sessionManager.getHeader(), ...structuredClone(session.sessionManager.getEntries())]);
  const before = manager.buildSessionProjection().messages.length;
  for (const e of entries) manager.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
  const projection = manager.buildSessionProjection();
  return { contextEntries: projection.entries, contextMessages: projection.messages,
    llmMessages: convertToLlm(projection.messages), pendingMessages: projection.messages.slice(before), canContinue: true };
}
function saved(agents, root, owner) {
  const agentId = randomUUID(), generation = randomUUID();
  const d = { agentId, release: packageVersion, workspace: root, cwd: root, parentSessionId: owner.sessionId, parentLeaf: owner.leaf,
    createdAt: Date.now(), options: { noSkills: true, noContextFiles: true } };
  agents.create(d, { generation, name: "review", sequence: 0, stop: false, startedAt: Date.now() });
  agents.write(agentId, "status.json", { generation, state: "idle", activity: "idle", updatedAt: Date.now(), accepted: [] }, status);
  return { ...d, generation, name: "review", owned: true, alive: true, state: "idle", activity: "idle" };
}

for (const messageType of ["user", "custom"]) test("native " + messageType + " start and turn-end accept original context without requesting continuation", async t => {
  const teamId = randomUUID();
  const link = { team: { teamId, messages: [{ seq: 1, text: "Raw evidence", author: { kind: "member", agentId: "a", name: "A" } }] } };
  const { session } = await host(t, { enabled: false, extensions: [pi => {
    // A real local extension probes the host contract used by the child adapter; no provider is invoked.
    pi.on("before_agent_start", (_e, ctx) => { const message = teamContext(link, ctx); if (message) return { message }; });
    pi.on("turn_end", (event, ctx) => { const message = teamContext(link, ctx); if (message) return { entries: [...event.entries, message] }; });
  }] });
  const trigger = messageType === "user" ? { messageType, prompt: "Work" }
    : { messageType, message: { role: "custom", customType: "pbot.team-results", content: "Completed batch", display: true, timestamp: 1 } };
  const started = await session.extensionRunner.emitBeforeAgentStart(trigger, { cwd: session.cwd });
  assert.equal(started.messages.length, 1);
  assert.equal(started.messages[0].customType, "pbot.team-context");
  const event = await session.extensionRunner.emitBoundary({ type: "turn_end", outcome: "completed" }, entries => boundaryPreview(session, entries));
  assert.equal(event.valid, true); assert.equal(event.continue, false);
  assert.deepEqual(event.entries[0].details, { teamId, seqs: [1] });
  for (const e of event.entries) session.sessionManager.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
  session.sessionManager.appendMessage({ role: "user", content: "Restored conversation", timestamp: 1 });
  assert.equal((await session.extensionRunner.emitBeforeAgentStart(trigger, { cwd: session.cwd })).messages.length, 0);
  assert.equal((await session.extensionRunner.emitBoundary({ type: "turn_end", outcome: "completed" }, entries => boundaryPreview(session, entries))).entries.length, 0);
  assert.equal(session.isIdle, true);
});

test("main team tools use real SDK schemas, keep reads separate from notification receipts, and become stale on close", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pbot-team-api-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { session, root } = await host(t), ctx = session.extensionRunner.createToolContext("local", undefined);
  await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
  const files = new AgentFiles(agentDirectory()), member = saved(files, root, agentOwner(ctx));
  const team = session.agent.state.tools.find(t => t.name === "pbot_team"), message = session.agent.state.tools.find(t => t.name === "pbot_team_message");
  const execute = async (tool, id, input) => {
    const output = await tool.execute(id, input);
    assert.ok(schema(tool.outputSchema)(output.structuredContent), JSON.stringify(output));
    return output.structuredContent;
  };
  const created = await execute(team, "create", { action: "create", name: "Local", brief: "Local history", members: [{ agentId: member.agentId, role: "review" }] });
  const posted = await execute(message, "post", { action: "post", teamId: created.teamId, text: "Public content" });
  assert.equal(posted.status, "stored");
  const read = await execute(message, "read", { action: "read", teamId: created.teamId });
  assert.equal(read.messages[0].author.kind, "coordinator");
  assert.equal(deliveredTeams(ctx).size, 0);
  await execute(team, "list", { action: "list" });
  await execute(team, "status", { action: "status", teamId: created.teamId });
  await assert.rejects(team.execute("run", { action: "run", teamId: created.teamId, mode: "parallel", instruction: "Needs a live member" }));
  await assert.rejects(message.execute("spoof", { action: "post", teamId: created.teamId, text: "x", sender: "other" }));
  // Restore a completed batch and its actual local transcript, then exercise the native notification boundary.
  const manager = SessionManager.create(root, join(directory, "sessions"), { id: member.agentId }), report = "Historical public report";
  manager.appendMessage({ role: "user", content: "Historical request", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: report }], api: "openai-responses",
    provider: "openai", model: "historical", stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  files.bindSession(member.agentId, manager.getSessionFile());
  const requestId = randomUUID(), runId = randomUUID(), cycleId = randomUUID(), teamFiles = new TeamFiles(files);
  files.write(member.agentId, "completions/" + cycleId + ".json", { cycleId, generation: member.generation, startedAt: 1, finishedAt: 2,
    state: "completed", leaf: manager.getLeafId(), requestIds: [requestId], source: "parent" }, cycle, true);
  files.control(() => {
    const record = teamFiles.read(created.teamId);
    record.runs.push({ runId, instruction: "Historical request", mode: "roundRobin", rounds: 1, maxConcurrent: 1, deadlineAt: Date.now(),
      generations: { [member.agentId]: member.generation }, state: "finished",
      issued: [{ requestId, agentId: member.agentId, generation: member.generation, round: 1, throughSeq: record.messages.length }] });
    record.messages.push({ seq: record.messages.length + 1, operationId: "result:" + requestId,
      author: { kind: "member", agentId: member.agentId, name: member.name }, text: report, runId, source: { requestId, cycleId } });
    teamFiles.save(record);
  });
  await execute(team, "read", { action: "read", teamId: created.teamId });
  assert.equal(deliveredTeams(ctx).size, 0);
  await session.extensionRunner.emitInput("Inspect the completed batch", undefined, "interactive");
  const notice = await session.extensionRunner.emitBoundary({ type: "turn_end", outcome: "completed" }, entries => boundaryPreview(session, entries));
  assert.equal(notice.valid, true); assert.equal(notice.continue, true);
  assert.deepEqual(notice.entries.map(e => e.customType), ["pbot.team-results"]);
  for (const e of notice.entries) session.sessionManager.appendCustomMessageEntry(e.customType, e.content, e.display, e.details);
  session.sessionManager.appendMessage({ role: "user", content: "Restored parent history", timestamp: 1 });
  assert.equal(deliveredTeams(ctx).size, 1);
  const repeated = await session.extensionRunner.emitBoundary({ type: "turn_end", outcome: "completed" }, entries => boundaryPreview(session, entries));
  assert.equal(repeated.entries.length, 0); assert.equal(repeated.continue, false);
  await session.extensionRunner.emit({ type: "agent_settled", aborted: true });
  await execute(team, "close", { action: "close", teamId: created.teamId });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await assert.rejects(team.execute("stale", { action: "list" }));
  await assert.rejects(message.execute("stale", { action: "read", teamId: created.teamId }));
});

for (const hasCycle of [true, false]) test("actual child reload seals accepted team work without replay: cycle=" + hasCycle, async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-team-reload-")), agents = new AgentFiles(join(root, "subagents"));
  const owner = { sessionId: "parent", leaf: null, branch: [] }, v = saved(agents, root, owner);
  const files = new TeamFiles(agents), service = new TeamService(root, agents, files);
  files.setReady(v.agentId, v.generation, true);
  const team = service.create(owner, { name: "reload", brief: "Known work", members: [{ agentId: v.agentId, role: "review" }] }, [v]);
  service.post(team.teamId, { kind: "coordinator", owner }, "public", "Shared before reload");
  service.run(team.teamId, owner, { instruction: "Work", mode: "roundRobin" }, [v]);
  const [q] = service.advance(owner, [v], []);
  agents.control(() => agents.enqueue(v.agentId, q.message, "followUp", [], q.requestId));
  const cycle = { cycleId: randomUUID(), generation: v.generation, startedAt: Date.now(), state: "running", leaf: null, requestIds: [q.requestId], source: "parent" };
  agents.write(v.agentId, "status.json", { generation: v.generation, state: "busy", activity: "busy", accepted: [q.requestId], updatedAt: Date.now(),
    ...(hasCycle ? { cycle } : {}) }, status);
  const initial = SessionManager.create(root, join(root, "sessions"), { id: v.agentId });
  initial.appendMessage({ role: "user", content: "Restored context", timestamp: 1 });
  agents.bindSession(v.agentId, initial.getSessionFile());
  const vars = { PBOT_SUBAGENT_RUN_ID: v.agentId, PBOT_SUBAGENT_DIR: agents.directory(v.agentId), PBOT_SUBAGENT_GENERATION: v.generation, PI_CODING_AGENT_DIR: join(root, "config") };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  let session;
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session?.dispose(); }
    finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
  const settingsManager = SettingsManager.inMemory(), agentDir = vars.PI_CODING_AGENT_DIR;
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [childEntry] });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, sessionManager: SessionManager.open(agents.session(v.agentId)) }));
  let starts = 0; session.subscribe(event => { if (event.type === "agent_start") starts++; });
  const errors = []; await session.bindExtensions({ mode: "json", onError: e => errors.push(e) });
  assert.deepEqual(errors, []);
  const ended = agents.completions(v.agentId);
  assert.equal(ended.length, 1); assert.equal(ended[0].state, "interrupted");
  assert.deepEqual(ended[0].requestIds, [q.requestId]);
  assert.equal(files.read(team.teamId).runs[0].state, "paused");
  assert.equal(agents.read(v.agentId, "status.json", status).state, "idle");
  assert.equal(files.ready(v.agentId).ready, true);
  const tool = session.agent.state.tools.find(t => t.name === "pbot_team_message");
  const read = await tool.execute("read", { action: "read", teamId: team.teamId });
  assert.ok(schema(tool.outputSchema)(read.structuredContent));
  await assert.rejects(tool.execute("post", { action: "post", teamId: team.teamId, text: "No active team work" }));
  for (const toolName of ["pbot_agent", "pbot_team"]) assert.equal((await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "manage", toolName, input: { action: "list" } })).block, true);
  assert.equal(starts, 0);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(files.ready(v.agentId).ready, false);
  await assert.rejects(tool.execute("stale", { action: "read", teamId: team.teamId }));
});

test("a real team publication failure disables later writes even after the path becomes readable again", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-team-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { sessionId: "parent", leaf: null, branch: [] }, agents = new AgentFiles(join(root, "subagents")), files = new TeamFiles(agents);
  const v = saved(agents, root, owner), service = new TeamService(root, agents, files);
  const team = service.create(owner, { name: "io", brief: "Check", members: [{ agentId: v.agentId, role: "review" }] }, [v]);
  const path = join(files.root, team.teamId, "team.json"), old = await readFile(path, "utf8");
  // Existing file type is invalid: atomic publication must reject it rather than overwrite or repair it.
  await rename(path, path + ".saved"); await mkdir(path);
  assert.throws(() => files.save(team));
  await rm(path, { recursive: true }); await rename(path + ".saved", path);
  assert.equal(files.read(team.teamId).messages.length, 0);
  assert.throws(() => service.post(team.teamId, { kind: "coordinator", owner }, "after", "Must not proceed"));
  assert.throws(() => agents.enqueue(v.agentId, "Must not send", "steer"));
  assert.equal(await readFile(path, "utf8"), old);
});
