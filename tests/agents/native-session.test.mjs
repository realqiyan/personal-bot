import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SessionManager, DefaultResourceLoader, createAgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { descriptor, launch, cycle, status } from "../../dist/storage/agent-files.js";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { TeamService } from "../../dist/services/agents/team-service.js";
import { PiAgents, tmuxName } from "../../dist/integrations/pi/pi-agents.js";
import { packageVersion } from "../../dist/common/version.js";
import childEntry from "../../dist/extension/subagent-entry.js";

const owner = { sessionId: "parent", leaf: null, branch: [] };
const options = { provider: "openai", model: "gpt-4.1", noSkills: true, noContextFiles: true, noPromptTemplates: true };

async function isolated(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-native-session-")), before = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: before.PATH, HOME: root, TERM: "xterm-256color", PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: join(root, "config"), TMUX_TMPDIR: root, XDG_DATA_HOME: join(root, "data") });
  const agents = new AgentService(root, join(root, "config/pbot/subagents"), new PiAgents());
  t.after(async () => {
    try { await agents.close(owner); } finally {
      spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
      for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, before);
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(join(root, "data/pbot/python/.venv"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  return { root, agents, agentDir: join(root, "config") };
}
async function until(predicate) {
  const deadline = Date.now() + 18000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), "local child did not reach the expected state");
}
async function stop(agents, id) {
  agents.stop(id, owner);
  await until(() => { agents.refresh(owner); return !agents.host.alive(id); });
}
function saved(agents, cwd) {
  const agentId = randomUUID(), generation = randomUUID();
  const d = { agentId, release: packageVersion, workspace: agents.root, cwd, parentSessionId: owner.sessionId,
    parentLeaf: null, createdAt: Date.now(), options };
  agents.files.create(d, { generation, name: "local", sequence: 0, stop: false, startedAt: Date.now() });
  return { ...d, generation };
}

// This local extension only observes real CLI startup. It supplies no provider or model response.
async function probeExtension(agentDir) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions/probe.ts"), `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    export default function(pi) {
      pi.on("session_start", (_event, ctx) => {
        writeFileSync(join(process.env.PBOT_SUBAGENT_DIR, "probe-" + process.env.PBOT_SUBAGENT_GENERATION + ".json"), JSON.stringify({
          id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd,
          model: ctx.model?.id, thinking: pi.getThinkingLevel(),
          users: ctx.sessionManager.getEntries().filter(e => e.type === "message" && e.message.role === "user").map(e => e.message.content)
        }));
      });
    }
  `);
}
async function probe(agents, child) {
  const path = join(agents.files.directory(child.agentId), "probe-" + child.generation + ".json");
  await until(() => existsSync(path));
  return JSON.parse(await readFile(path, "utf8"));
}

test("real CLI chooses native cwd directories and settings, clears stale tmux overrides, and resumes empty standby", { timeout: 60000 }, async t => {
  const { root, agents, agentDir } = await isolated(t);
  await probeExtension(agentDir);
  const cases = [
    { name: "environment", setting: "~/configured", env: "~/environment", expected: join(root, "environment") },
    { name: "settings", setting: "~/configured", expected: join(root, "configured") },
    { name: "default" },
  ];
  for (const scenario of cases) {
    const cwd = join(root, "projects", scenario.name); await mkdir(cwd, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(scenario.setting ? { sessionDir: scenario.setting } : {}));
    if (scenario.env) process.env.PI_CODING_AGENT_SESSION_DIR = scenario.env; else delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const child = agents.start({ ...options, cwd, noExtensions: false }, owner), native = await probe(agents, child);
    await until(() => agents.list(owner).find(v => v.agentId === child.agentId)?.state === "idle");
    const expected = scenario.expected ?? SessionManager.create(cwd).getSessionDir();
    assert.equal(native.cwd, cwd); assert.equal(native.id, child.agentId); assert.equal(dirname(native.file), expected);
    assert.equal(agents.files.session(child.agentId), null); assert.equal(existsSync(native.file), false);
    assert.equal(SessionManager.findById(cwd, child.agentId, expected), undefined);
    assert.deepEqual(await SessionManager.list(cwd, expected), []);
    assert.deepEqual(agents.files.messages(child.agentId), []);
    assert.equal(existsSync(join(agents.files.directory(child.agentId), "session.jsonl")), false);
    await stop(agents, child.agentId);
    assert.deepEqual(agents.cycles(child.agentId, owner), []);
    // The explicit new request fails authentication, not session restoration. No provider is called.
    const resumed = agents.resume(child.agentId, "New input after empty standby", owner), reopened = await probe(agents, resumed);
    assert.equal(reopened.id, child.agentId); assert.equal(dirname(reopened.file), expected);
    assert.notEqual(resumed.generation, child.generation);
    await until(() => !agents.host.alive(child.agentId));
    assert.equal(agents.files.session(child.agentId), null); assert.equal(existsSync(reopened.file), false);
  }
});

test("real managed resume opens the bound native file and leaves saved model selection to Pi despite directory changes", { timeout: 30000 }, async t => {
  const { root, agents, agentDir } = await isolated(t);
  await probeExtension(agentDir);
  const cwd = join(root, "project"); await mkdir(cwd);
  const child = agents.start({ ...options, cwd, noExtensions: false }, owner), first = await probe(agents, child);
  await stop(agents, child.agentId);
  // Restore a local user history through the actual SDK. No assistant response or provider is used.
  const manager = SessionManager.create(cwd, dirname(first.file), { id: child.agentId });
  manager.appendModelChange("openai", "gpt-4.1-mini"); manager.appendThinkingLevelChange("off");
  manager.appendMessage({ role: "user", content: "Saved local context", timestamp: 1 });
  agents.files.bindSession(child.agentId, manager.getSessionFile());
  agents.rename(child.agentId, "retained-native-session", owner);
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "other-sessions");
  const other = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR, { id: child.agentId });
  other.appendMessage({ role: "user", content: "A different file must not be selected", timestamp: 2 });
  const otherBefore = await readFile(other.getSessionFile(), "utf8");
  const resumed = agents.resume(child.agentId, "Only this new request", owner), reopened = await probe(agents, resumed);
  assert.equal(reopened.file, manager.getSessionFile()); assert.equal(reopened.id, child.agentId);
  assert.deepEqual(reopened.users, ["Saved local context"]); assert.equal(reopened.thinking, "off");
  // Pi cannot restore an authenticated model here. It must not receive the original start model as an override.
  assert.notEqual(reopened.model, options.model);
  await until(() => !agents.host.alive(child.agentId));
  assert.deepEqual(SessionManager.open(manager.getSessionFile()).buildSessionContext().model, { provider: "openai", modelId: "gpt-4.1-mini" });
  const listed = await SessionManager.list(cwd, dirname(manager.getSessionFile()));
  assert.equal(listed.find(s => s.id === child.agentId)?.name, "retained-native-session");
  assert.equal(await readFile(other.getSessionFile(), "utf8"), otherBefore);
});

test("missing, invalid or foreign native files reject resume before generation or inbox changes", async t => {
  const { root, agents } = await isolated(t);
  const otherCwd = join(root, "other"); await mkdir(otherCwd);
  for (const kind of ["missing", "empty", "invalid", "malformed-tail", "legacy-version", "foreign-id", "foreign-cwd", "directory", "symlink"]) {
    const d = saved(agents, root);
    const manager = SessionManager.create(kind === "foreign-cwd" ? otherCwd : root, join(root, "sessions"),
      { id: kind === "foreign-id" ? randomUUID() : d.agentId });
    manager.appendMessage({ role: "user", content: "Local record", timestamp: 1 });
    const path = manager.getSessionFile();
    if (kind === "missing") await rm(path);
    if (kind === "empty") await writeFile(path, "");
    if (kind === "invalid") await writeFile(path, "not JSONL\n");
    if (kind === "malformed-tail") await writeFile(path, (await readFile(path, "utf8")) + "{unfinished");
    if (kind === "legacy-version") {
      const lines = (await readFile(path, "utf8")).split("\n"), header = JSON.parse(lines[0]);
      lines[0] = JSON.stringify({ ...header, version: 2 }); await writeFile(path, lines.join("\n"));
    }
    if (kind === "directory") { await rm(path); await mkdir(path); }
    if (kind === "symlink") { await rename(path, path + ".target"); await symlink(path + ".target", path); }
    agents.files.bindSession(d.agentId, path);
    const before = ["empty", "invalid", "malformed-tail", "legacy-version", "foreign-id", "foreign-cwd", "symlink"].includes(kind) ? await readFile(path, "utf8") : null;
    assert.throws(() => agents.resume(d.agentId, "Must not enqueue", owner));
    assert.equal(agents.files.read(d.agentId, "launch.json", launch).generation, d.generation);
    assert.deepEqual(agents.files.messages(d.agentId), []); assert.equal(agents.host.alive(d.agentId), false);
    if (before !== null) assert.equal(await readFile(path, "utf8"), before);
    assert.throws(() => agents.files.bindSession(d.agentId, join(root, "replacement.jsonl")));
  }
});

test("fixed-leaf reports are read-only and a missing transcript cannot become an empty success", async t => {
  const { root, agents } = await isolated(t), d = saved(agents, root);
  const manager = SessionManager.create(root, undefined, { id: d.agentId });
  manager.appendMessage({ role: "user", content: "Restored task record", timestamp: 1 });
  // Structured historical records exercise native branch lookup, not a simulated provider.
  const answer = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "historical",
    stopReason: "stop", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const leaf = manager.appendMessage(answer("Original report"));
  manager.resetLeaf(); manager.appendMessage({ role: "user", content: "Another branch", timestamp: 3 }); manager.appendMessage(answer("Later report"));
  const file = manager.getSessionFile(); agents.files.bindSession(d.agentId, file);
  const completed = { cycleId: randomUUID(), generation: d.generation, startedAt: 1, finishedAt: 2, state: "completed", leaf, source: "parent", requestIds: [] };
  agents.files.write(d.agentId, "completions/" + completed.cycleId + ".json", completed, cycle, true);
  const before = await readFile(file, "utf8");
  assert.equal(agents.read(d.agentId, owner).report, "Original report");
  assert.equal(agents.completions(owner)[0].report, "Original report");
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await SessionManager.list(root)).find(s => s.id === d.agentId)?.path, file);
  await rm(file); assert.throws(() => agents.read(d.agentId, owner)); assert.throws(() => agents.completions(owner));
});

for (const mode of ["input", "binding-io", "missing-on-load"]) test("native child binds before input and rejects uncertain references: " + mode, async t => {
  const { root, agents, agentDir } = await isolated(t), d = saved(agents, root);
  Object.assign(process.env, { PBOT_SUBAGENT_RUN_ID: d.agentId, PBOT_SUBAGENT_DIR: agents.files.directory(d.agentId), PBOT_SUBAGENT_GENERATION: d.generation });
  const manager = SessionManager.create(root, undefined, { id: d.agentId }), settingsManager = SettingsManager.inMemory();
  if (mode === "missing-on-load") agents.files.bindSession(d.agentId, manager.getSessionFile());
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [childEntry] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel("openai", "gpt-4.1"),
    sessionManager: manager, settingsManager, resourceLoader: loader });
  const errors = []; let starts = 0;
  session.subscribe(event => { if (event.type === "agent_start") starts++; });
  try {
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    assert.deepEqual(errors, []);
    if (mode === "missing-on-load") {
      assert.equal(agents.files.session(d.agentId), manager.getSessionFile());
      assert.ok(agents.files.read(d.agentId, "status.json", status).error);
      assert.equal(agents.teamFiles.ready(d.agentId)?.ready, false);
      assert.equal(existsSync(manager.getSessionFile()), false); assert.equal(starts, 0);
      return;
    }
    assert.equal(agents.files.session(d.agentId), null);
    if (mode === "binding-io") {
      const ref = join(agents.files.directory(d.agentId), "session-ref.json");
      await rename(ref, ref + ".saved"); await mkdir(ref);
      await session.prompt("Must be handled without reaching the model");
    } else {
      await assert.rejects(session.prompt("No credentials: input may not reach a model"));
      assert.equal(agents.files.session(d.agentId), manager.getSessionFile());
      assert.throws(() => agents.resume(d.agentId, "Cannot replace an uncertain conversation", owner));
      assert.equal(agents.files.read(d.agentId, "launch.json", launch).generation, d.generation);
    }
    assert.equal(starts, 0); assert.equal(existsSync(manager.getSessionFile()), false);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
  }
});

test("old layouts remain untouched and cannot block new agents or trigger automatic team recovery", async t => {
  const { root, agents } = await isolated(t), d = saved(agents, root);
  const teams = new TeamService(root, agents.files, agents.teamFiles), v = { ...d, owned: true, alive: true, state: "idle", name: "old", activity: "idle" };
  const team = teams.create(owner, { name: "old", brief: "Historical", members: [{ agentId: d.agentId, role: "review" }] }, [v]);
  team.release = "0.1.3";
  team.runs.push({ runId: randomUUID(), instruction: "Historical work", mode: "roundRobin", rounds: 1, maxConcurrent: 1,
    deadlineAt: Date.now() + 900000, generations: { [d.agentId]: d.generation }, state: "running", issued: [] });
  agents.teamFiles.save(team);
  agents.files.write(d.agentId, "descriptor.json", { ...agents.files.read(d.agentId, "descriptor.json", descriptor), release: "0.1.3" }, descriptor);
  await rm(join(agents.files.directory(d.agentId), "session-ref.json"));
  const legacy = join(agents.files.directory(d.agentId), "session.jsonl"); await writeFile(legacy, "Historical user data\n");
  const paths = [legacy, join(agents.files.directory(d.agentId), "descriptor.json"), join(agents.files.directory(d.agentId), "launch.json"), join(agents.teamFiles.root, team.teamId, "team.json")];
  const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
  assert.deepEqual(agents.list(owner), []); assert.deepEqual(agents.completions(owner), []);
  assert.throws(() => agents.resume(d.agentId, "Do not migrate", owner));
  teams.recover(owner); assert.deepEqual(teams.list(owner, []), []); assert.deepEqual(teams.advance(owner, [], []), []);
  const current = saved(agents, root); assert.deepEqual(agents.list(owner).map(v => v.agentId), [current.agentId]);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), before);
  assert.equal(existsSync(join(agents.files.directory(d.agentId), "session-ref.json")), false);
  // A missing reference in the current line is also an error, not permission to create a blank session.
  await rm(join(agents.files.directory(current.agentId), "session-ref.json"));
  assert.throws(() => agents.resume(current.agentId, "Do not recreate", owner));
  assert.equal(spawnSync("tmux", ["has-session", "-t", "=" + tmuxName(current.agentId)], { stdio: "ignore" }).status, 1);
});
