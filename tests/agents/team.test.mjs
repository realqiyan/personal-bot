import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentFiles, launch, status, cycle } from "../../dist/storage/agent-files.js";
import { TeamFiles, teamRecord } from "../../dist/storage/team-files.js";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { TeamService } from "../../dist/services/agents/team-service.js";
import { PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { teamContext, deliveredTeams } from "../../dist/integrations/pi/team-context.js";
import { teamParametersSchema, teamActionSchema, teamMessageActionSchema } from "../../dist/tools/teams/contract.js";
import { schema } from "../../dist/common/validation.js";
import { packageVersion } from "../../dist/common/version.js";
import { host } from "../helpers/pi-host.mjs";

const owner = { sessionId: "parent", leaf: "anchor", branch: ["anchor"] };
const actor = { kind: "coordinator", owner };
const exec = promisify(execFile);

// Plain domain inputs and restored local execution records; no model/provider implementation.
async function fixture(t, count = 3, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pbot-team-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = new AgentFiles(join(root, "subagents")), files = new TeamFiles(agents), service = new TeamService(root, agents, files), views = [];
  for (let n = 0; n < count; n++) {
    const d = { agentId: randomUUID(), release: packageVersion, workspace: root, cwd: root,
      parentSessionId: owner.sessionId, parentLeaf: owner.leaf, createdAt: Date.now(), options };
    const generation = randomUUID(), name = "member-" + n;
    agents.create(d, { generation, name, sequence: 0, stop: false, startedAt: Date.now() });
    agents.write(d.agentId, "status.json", { generation, state: "idle", activity: "idle", updatedAt: Date.now(), accepted: [] }, status);
    files.setReady(d.agentId, generation, true);
    views.push({ ...d, generation, name, owned: true, alive: true, state: "idle", activity: "idle" });
  }
  service.recover(owner);
  const input = { name: "local", brief: "Compare local evidence", members: views.map(v => ({ agentId: v.agentId, role: "review" })) };
  const team = service.create(owner, input, views), completions = [];
  const queue = q => agents.control(() => agents.enqueue(q.agentId, q.message, "followUp", [], q.requestId));
  const claim = q => service.claim(q.agentId, q.generation, q.requestId, () => {
    const saved = agents.read(q.agentId, "status.json", status);
    const c = { cycleId: randomUUID(), generation: q.generation, startedAt: Date.now(), state: "running", leaf: null, requestIds: [q.requestId], source: "parent" };
    agents.write(q.agentId, "status.json", { ...saved, state: "busy", accepted: [...(saved.accepted ?? []), q.requestId], cycle: c }, status);
    Object.assign(views.find(v => v.agentId === q.agentId), { state: "busy", cycle: c });
  });
  const finish = async (q, source = "parent", state = "completed") => {
    const saved = agents.read(q.agentId, "status.json", status), path = agents.session(q.agentId);
    const manager = path ? SessionManager.open(path) : SessionManager.create(root, join(root, "sessions"), { id: q.agentId });
    manager.appendMessage({ role: "user", content: "Restored work record", timestamp: 1 });
    const report = JSON.stringify({ agentId: q.agentId, round: q.round, value: 42 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: report }], api: "openai-responses",
      provider: "openai", model: "historical", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    agents.bindSession(q.agentId, manager.getSessionFile());
    const c = { ...saved.cycle, cycleId: saved.cycle?.cycleId ?? randomUUID(), generation: q.generation, startedAt: 1, finishedAt: 2,
      state, source, leaf: manager.getLeafId(), requestIds: [q.requestId] };
    agents.write(q.agentId, "completions/" + c.cycleId + ".json", c, cycle, true);
    agents.write(q.agentId, "status.json", { ...saved, state: "idle", cycle: c }, status);
    Object.assign(views.find(v => v.agentId === q.agentId), { state: "idle", cycle: c });
    const result = { agentId: q.agentId, name: views.find(v => v.agentId === q.agentId).name, cycle: c, report: new PiAgents().report(views.find(v => v.agentId === q.agentId), manager.getSessionFile(), c.leaf) };
    completions.push(result); return result;
  };
  return { root, agents, files, service, views, input, team, completions, queue, claim, finish,
    advance: () => service.advance(owner, views, completions) };
}

test("round robin preserves raw reports, fixed order and subagent descriptors", async t => {
  const f = await fixture(t, 2);
  const before = await Promise.all(f.views.map(v => readFile(join(f.agents.directory(v.agentId), "descriptor.json"), "utf8")));
  f.service.post(f.team.teamId, actor, "initial", "Shared evidence");
  f.service.run(f.team.teamId, owner, { instruction: "Review", mode: "roundRobin", rounds: 2 }, f.views);
  for (let n = 0; n < 4; n++) {
    const inputs = f.advance(); assert.equal(inputs.length, 1);
    const q = inputs[0]; assert.equal(q.agentId, f.views[n % 2].agentId); assert.equal(q.round, Math.floor(n / 2) + 1);
    assert.equal(q.throughSeq, n + 1);
    assert.equal(f.agents.messages(q.agentId).some(m => m.requestId === q.requestId), false);
    f.queue(q); f.queue(q);
    assert.equal(f.agents.messages(q.agentId).filter(m => m.requestId === q.requestId).length, 1);
    assert.deepEqual(f.advance(), []);
    assert.ok(f.claim(q)); assert.equal(f.claim(q), undefined);
    await f.finish(q);
  }
  assert.deepEqual(f.advance(), []);
  const record = f.files.read(f.team.teamId);
  assert.equal(record.runs[0].state, "finished");
  assert.deepEqual(record.messages.slice(1).map(m => m.text), f.completions.map(c => c.report));
  f.advance(); assert.equal(f.files.read(f.team.teamId).messages.length, 5);
  assert.deepEqual(await Promise.all(f.views.map(v => readFile(join(f.agents.directory(v.agentId), "descriptor.json"), "utf8"))), before);
  for (const v of f.views) assert.equal(f.agents.read(v.agentId, "launch.json", launch).sequence, 2);
});

test("parallel rounds reserve queued slots and meet at the round barrier", async t => {
  const f = await fixture(t);
  f.service.run(f.team.teamId, owner, { instruction: "Parallel review", mode: "parallel", rounds: 2, maxConcurrent: 2 }, f.views);
  const first = f.advance(); assert.equal(first.length, 2);
  assert.deepEqual(f.advance(), []);
  for (const q of first) { f.queue(q); f.claim(q); }
  await f.finish(first[0]);
  const [third] = f.advance(); assert.equal(third.agentId, f.views[2].agentId); assert.equal(third.round, 1);
  f.queue(third); f.claim(third); await f.finish(third);
  assert.deepEqual(f.advance(), []);
  await f.finish(first[1]);
  const next = f.advance(); assert.equal(next.length, 2); assert.ok(next.every(q => q.round === 2 && q.throughSeq === 3));
  const old = f.files.read(f.team.teamId);
  const restored = new TeamService(f.root, f.agents, f.files); restored.recover(owner);
  assert.equal(f.files.read(f.team.teamId).runs[0].state, "paused");
  assert.deepEqual(restored.advance(owner, f.views, f.completions), []);
  assert.equal(f.files.read(f.team.teamId).runs[0].issued.length, old.runs[0].issued.length);
  assert.ok(next.every(q => !f.agents.messages(q.agentId).some(m => m.requestId === q.requestId)));
});

test("pause orders claims, allows in-flight explicit posts, and does not publish mixed private replies", async t => {
  const f = await fixture(t, 2);
  f.service.run(f.team.teamId, owner, { instruction: "Compare", mode: "parallel" }, f.views);
  const [a, b] = f.advance(); f.queue(a); f.queue(b); f.claim(a);
  f.service.pause(f.team.teamId, owner);
  assert.equal(f.claim(b), undefined);
  assert.equal(f.service.status(f.team.teamId, owner, f.views).activeCount, 1);
  assert.throws(() => f.service.close(f.team.teamId, owner, f.views));
  const member = { kind: "member", agentId: a.agentId, generation: a.generation, requestId: a.requestId };
  const post = f.service.post(f.team.teamId, member, "one", "Explicit public finding");
  assert.equal(f.service.post(f.team.teamId, member, "one", post.text).seq, post.seq);
  assert.throws(() => f.service.post(f.team.teamId, { ...member, agentId: b.agentId, generation: b.generation }, "other", "No current task"));
  await f.finish(a, "mixed");
  f.advance();
  assert.equal(f.files.read(f.team.teamId).messages.length, 1);
  assert.equal(f.service.status(f.team.teamId, owner, f.views).unresolved.find(q => q.requestId === a.requestId).state, "mixed");
  f.service.close(f.team.teamId, owner, f.views);
  assert.equal(f.files.read(f.team.teamId).closed, true);
  assert.throws(() => f.service.post(f.team.teamId, actor, "late", "No"));
  const again = f.service.create(owner, f.input, f.views);
  assert.notEqual(again.teamId, f.team.teamId);
});

test("team scope, readiness and generation checks do not silently switch or resume work", async t => {
  const f = await fixture(t, 1), id = f.views[0].agentId;
  assert.throws(() => f.service.create(owner, f.input, f.views));
  assert.throws(() => f.service.read(f.team.teamId, { ...actor, owner: { ...owner, branch: [] } }));
  assert.throws(() => f.service.status(f.team.teamId, { ...owner, sessionId: "fork" }, f.views));
  f.files.setReady(id, f.views[0].generation, false);
  assert.throws(() => f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "parallel" }, f.views));
  f.files.setReady(id, f.views[0].generation, true);
  const privateInput = f.agents.control(() => f.agents.enqueue(id, "Private", "steer"));
  assert.throws(() => f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "parallel" }, f.views));
  const saved = f.agents.read(id, "status.json", status);
  f.agents.write(id, "status.json", { ...saved, accepted: [privateInput.requestId] }, status);
  f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "parallel" }, f.views);
  f.views[0].generation = randomUUID();
  assert.deepEqual(f.advance(), []);
  assert.equal(f.files.read(f.team.teamId).runs[0].state, "paused");
});

test("deadlines and lost branches stop new claims and keep foreign task details hidden", async t => {
  const f = await fixture(t, 1);
  f.service.run(f.team.teamId, owner, { instruction: "Bounded", mode: "parallel" }, f.views);
  const [q] = f.advance(); f.queue(q);
  const stored = f.files.read(f.team.teamId); stored.runs[0].deadlineAt = Date.now() - 1;
  f.agents.control(() => f.files.save(stored));
  assert.equal(f.claim(q), undefined); assert.deepEqual(f.advance(), []);
  assert.equal(f.files.read(f.team.teamId).runs[0].state, "paused");
  f.service.run(f.team.teamId, owner, { instruction: "Explicit new batch", mode: "roundRobin" }, f.views);
  const foreign = { ...owner, branch: [] };
  assert.deepEqual(f.service.advance(foreign, f.views, []), []);
  assert.equal(f.files.read(f.team.teamId).runs[1].state, "paused");
  assert.deepEqual(f.service.list(foreign, f.views), [{ teamId: f.team.teamId, name: f.team.name, closed: false, owned: false }]);
  assert.deepEqual(f.service.notifications(foreign, f.views), []);
  assert.equal(f.agents.messages(q.agentId).length, 1);
});

test("a stopped peer blocks remaining claims before the next parent scan", async t => {
  const f = await fixture(t, 2);
  f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "parallel" }, f.views);
  const [a, b] = f.advance(); f.queue(a); f.queue(b);
  f.agents.control(() => {
    const run = f.agents.read(a.agentId, "launch.json", launch); run.stop = true;
    f.agents.write(a.agentId, "launch.json", run, launch);
  });
  assert.equal(f.claim(b), undefined);
  assert.equal(f.agents.read(b.agentId, "status.json", status).accepted.length, 0);
});

test("resume seals receipt-only crashes before changing generation and never reclassifies them as unclaimed", { timeout: 20000 }, async t => {
  const f = await fixture(t, 1, { provider: "not-configured", model: "not-configured", noSkills: true, noContextFiles: true });
  const before = { ...process.env }, socketRoot = await mkdtemp(join(tmpdir(), "pbot-receipt-tmux-"));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: before.PATH, HOME: f.root, TERM: "xterm-256color", PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: join(f.root, "isolated-config"), TMUX_TMPDIR: socketRoot, XDG_DATA_HOME: before.XDG_DATA_HOME });
  const agents = new AgentService(f.root, f.agents.root, new PiAgents()), id = f.views[0].agentId;
  t.after(async () => {
    if (agents.host.alive(id)) agents.host.kill(id);
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, before);
    await rm(socketRoot, { recursive: true, force: true });
  });
  f.service.run(f.team.teamId, owner, { instruction: "Old work", mode: "roundRobin" }, f.views);
  const [q] = f.advance(); f.queue(q);
  const native = SessionManager.create(f.root, join(f.root, "sessions"), { id });
  native.appendMessage({ role: "user", content: "Accepted work before interruption", timestamp: 1 });
  f.agents.bindSession(id, native.getSessionFile());
  f.service.claim(id, q.generation, q.requestId, () => {
    f.agents.write(id, "status.json", { generation: q.generation, state: "busy", activity: "accepted", updatedAt: Date.now(), accepted: [q.requestId] }, status);
  });
  f.service.pause(f.team.teamId, owner);
  assert.equal(f.service.status(f.team.teamId, owner, agents.list(owner)).unresolved[0].state, "uncertain");
  const resumed = agents.resume(id, "Only this new instruction", owner);
  assert.notEqual(resumed.generation, q.generation);
  const ended = agents.files.completions(id).find(c => c.requestIds.includes(q.requestId));
  assert.equal(ended.state, "interrupted"); assert.equal(ended.generation, q.generation);
  assert.equal(agents.files.messages(id).filter(m => m.generation === resumed.generation).length, 1);
  const deadline = Date.now() + 15000;
  while (agents.host.alive(id) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.equal(agents.host.alive(id), false);
  assert.equal(f.service.status(f.team.teamId, owner, agents.list(owner)).unresolved[0].state, "interrupted");
  await agents.close(owner);
});

test("unknown accepted work is visible, and recovery only republishes completed records", async t => {
  const f = await fixture(t, 2);
  f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "parallel" }, f.views);
  const [a, b] = f.advance();
  for (const q of [a, b]) { f.queue(q); f.claim(q); }
  const done = await f.finish(a);
  f.views.find(v => v.agentId === b.agentId).alive = false;
  const restored = new TeamService(f.root, f.agents, f.files); restored.recover(owner);
  assert.deepEqual(restored.advance(owner, f.views, f.completions), []);
  const result = restored.status(f.team.teamId, owner, f.views);
  assert.equal(result.unresolved.find(q => q.requestId === b.requestId).state, "uncertain");
  assert.equal(f.files.read(f.team.teamId).messages[0].text, done.report);
  restored.advance(owner, f.views, f.completions);
  assert.equal(f.files.read(f.team.teamId).messages.length, 1);
  assert.equal(f.agents.messages(b.agentId).length, 1);
});

test("bounded message pages retain every original character and reject invalid stored associations", async t => {
  const f = await fixture(t, 1), text = "数据🙂".repeat(3000);
  const m = f.service.post(f.team.teamId, actor, "long", text);
  f.service.post(f.team.teamId, actor, "reply", "Second", m.seq);
  const first = f.service.read(f.team.teamId, actor, { limit: 31 });
  assert.equal(first.messages[0].nextOffset, 31);
  let reconstructed = "", offset = 0;
  do {
    const page = f.service.read(f.team.teamId, actor, { seq: m.seq, offset, limit: 1000 });
    reconstructed += page.messages[0].text; offset = page.messages[0].nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, text);
  assert.equal(f.service.read(f.team.teamId, actor, { afterSeq: 1 }).messages[0].replyTo, 1);
  const bad = f.files.read(f.team.teamId); bad.messages[1].seq = 9;
  assert.throws(() => teamRecord(bad)); assert.throws(() => f.files.save(bad));
  assert.equal(f.service.post(f.team.teamId, actor, "valid", "Still usable").seq, 3);
  assert.equal(schema(teamParametersSchema)({ action: "run", teamId: f.team.teamId, mode: "parallel", instruction: "Work" }), true);
  assert.equal(schema(teamActionSchema)({ action: "run", teamId: f.team.teamId, mode: "parallel" }), false);
  assert.equal(schema(teamMessageActionSchema)({ action: "post", teamId: f.team.teamId, text: "x", author: "other" }), false);
});

test("independent local publishers serialize on the existing lock without losing messages", async t => {
  const f = await fixture(t, 1);
  const code = `
    import { AgentFiles } from "./dist/storage/agent-files.js";
    import { TeamFiles } from "./dist/storage/team-files.js";
    import { TeamService } from "./dist/services/agents/team-service.js";
    const [root, directory, id, worker, owner] = process.argv.slice(1);
    const agents = new AgentFiles(directory), service = new TeamService(root, agents, new TeamFiles(agents));
    for (let n=0;n<8;n++) for (;;) {
      try { service.post(id, {kind:"coordinator",owner:JSON.parse(owner)}, worker+":"+n, worker+":"+n); break; }
      catch(e) { if(e.code!=="PBOT_CONTROL_BUSY") throw e; await new Promise(r=>setTimeout(r,10)); }
    }
  `;
  await Promise.all(["a", "b", "c"].map(worker => exec(process.execPath, ["--input-type=module", "-e", code, f.root, f.agents.root, f.team.teamId, worker, JSON.stringify(owner)], { cwd: resolve("."), timeout: 10000 })));
  const messages = f.files.read(f.team.teamId).messages;
  assert.equal(messages.length, 24); assert.equal(new Set(messages.map(m => m.operationId)).size, 24);
  assert.deepEqual(messages.map(m => m.seq), Array.from({ length: 24 }, (_, i) => i + 1));
});

function contextMessages(content) {
  return [...content.matchAll(/^## [^\n]+\n([\s\S]*?)\n(`{3,})text\n([\s\S]*?)\n\2(?=\n|$)/gm)].map(match => {
    const fields = Object.fromEntries([...match[1].matchAll(/`(\w+)`: `([^`]+)`/g)].map(value => [value[1], value[2]]));
    return { ...fields, text: match[3], offset: Number(fields.offset), totalLength: Number(fields.totalLength),
      nextOffset: fields.nextOffset === "null" ? null : Number(fields.nextOffset) };
  });
}

test("native custom context persists without a model turn and rebuilds deduplication from the active branch", async t => {
  const f = await fixture(t, 1), { session } = await host(t, { enabled: false });
  f.service.post(f.team.teamId, actor, "evidence", "Original member evidence\n\n# Heading\n```json\n{\"value\": 42}\n```\n````\nEnd\n");
  f.service.run(f.team.teamId, owner, { instruction: "Work", mode: "roundRobin", rounds: 1 }, f.views);
  const [q] = f.advance(), link = f.service.links().get(q.requestId), ctx = session.extensionRunner.createToolContext("local", undefined);
  let starts = 0; const unsubscribe = session.subscribe(e => { if (e.type === "agent_start") starts++; });
  const context = teamContext(link, ctx);
  const data = contextMessages(context.content);
  assert.equal(data[0].text, f.files.read(f.team.teamId).messages[0].text);
  await session.sendCustomMessage(context, { triggerTurn: false });
  assert.equal(starts, 0); assert.equal(session.isIdle, true);
  assert.equal(teamContext(link, ctx), undefined);
  // A custom-only empty transcript need not be durable until native conversation content exists.
  session.sessionManager.appendMessage({ role: "user", content: "Restored input", timestamp: 1 });
  const opened = SessionManager.open(session.sessionFile);
  assert.deepEqual(opened.getBranch().find(e => e.type === "custom_message").details.seqs, [1]);
  session.sessionManager.appendCustomMessageEntry("pbot.team-results", "Status", true, { keys: ["t:r:paused:settled"] });
  assert.ok(deliveredTeams(ctx).has("t:r:paused:settled"));
  session.sessionManager.resetLeaf();
  assert.ok(teamContext(link, ctx)); assert.equal(deliveredTeams(ctx).size, 0);
  for (const [name, text] of [["ascii", "x".repeat(24000)], ["escaped", "\u0000".repeat(24000)], ["fences", "`".repeat(24000)]]) {
    f.service.post(f.team.teamId, actor, name, text);
    const large = teamContext(f.service.links().get(q.requestId), ctx);
    const last = contextMessages(large.content).at(-1);
    assert.ok(large.content.length <= 16000); assert.ok(last.nextOffset > 0);
    assert.ok(last.nextOffset < text.length); assert.equal(last.text, text.slice(0, last.nextOffset));
    const remainder = f.service.read(f.team.teamId, actor, { seq: large.details.seqs.at(-1), offset: last.nextOffset });
    assert.equal(last.text + remainder.messages[0].text, text.slice(0, last.nextOffset + remainder.messages[0].text.length));
    await session.sendCustomMessage(large, { triggerTurn: false });
  }
  f.queue(q); f.claim(q); const completed = await f.finish(q); f.advance();
  const published = contextMessages(teamContext(f.service.links().get(q.requestId), ctx).content)[0];
  assert.equal(published.runId, q.runId); assert.equal(published.requestId, q.requestId);
  assert.equal(published.cycleId, completed.cycle.cycleId); assert.equal(published.text, completed.report);
  assert.equal(starts, 0);
  unsubscribe();
});

test("real idle Pi children do not call a model, and team use retains the original inbox", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-idle-pi-")), before = { ...process.env };
  // Isolate both Pi auth and the tmux server. No inherited provider credentials reach these processes.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: before.PATH, HOME: root, TERM: "xterm-256color",
    PI_CODING_AGENT_DIR: join(root, "config"), TMUX_TMPDIR: root, XDG_DATA_HOME: join(root, "data") });
  await mkdir(join(root, "data/pbot/python/.venv"), { recursive: true });
  const agents = new AgentService(root, join(root, "subagents"), new PiAgents()), teams = new TeamService(root, agents.files, agents.teamFiles);
  t.after(async () => {
    try { await agents.close(owner); } finally {
      spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
      for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, before);
      await rm(root, { recursive: true, force: true });
    }
  });
  const children = [0, 1].map(n => agents.start({ name: "idle-" + n, provider: "openai", model: "gpt-4.1",
    noSkills: true, noContextFiles: true, noPromptTemplates: true }, owner));
  let deadline = Date.now() + 20000;
  while (Date.now() < deadline && !agents.list(owner).every(v => v.state === "idle" && agents.teamFiles.ready(v.agentId)?.ready)) await new Promise(r => setTimeout(r, 100));
  assert.ok(agents.list(owner).every(v => v.state === "idle"), JSON.stringify(agents.list(owner)));
  for (const v of children) {
    assert.equal(v.requestId, undefined); assert.equal(agents.files.messages(v.agentId).length, 0);
    assert.equal(agents.files.read(v.agentId, "launch.json", launch).sequence, 0);
    assert.deepEqual(agents.cycles(v.agentId, owner), []);
    assert.equal(agents.files.session(v.agentId), null);
    assert.equal(SessionManager.findById(root, v.agentId), undefined);
  }
  teams.recover(owner);
  const team = teams.create(owner, { name: "live", brief: "No authenticated model", members: children.map(v => ({ agentId: v.agentId, role: "review" })) }, agents.list(owner));
  teams.run(team.teamId, owner, { instruction: "Work", mode: "parallel", rounds: 1 }, agents.list(owner));
  assert.throws(() => agents.send(children[0].agentId, "private", "steer", owner), { code: "TEAM_BUSY" });
  const inputs = teams.advance(owner, agents.list(owner), []);
  for (const input of inputs) agents.enqueueTeam(input, owner);
  deadline = Date.now() + 10000;
  while (Date.now() < deadline && (teams.files.read(team.teamId).runs[0].state === "running" || agents.list(owner).some(v => v.alive && v.state !== "idle"))) await new Promise(r => setTimeout(r, 100));
  teams.advance(owner, agents.list(owner), agents.completions(owner));
  assert.equal(teams.status(team.teamId, owner, agents.list(owner)).run.state, "paused");
  assert.ok(children.some(v => !agents.host.alive(v.agentId)));
  assert.ok(agents.list(owner).every(v => !v.alive || v.state === "idle"));
  for (const q of inputs) assert.equal(agents.files.messages(q.agentId)[0].requestId, q.requestId);
  // A distinct idle process can stop without inventing a failed task.
  const empty = agents.start({ provider: "openai", model: "gpt-4.1", noSkills: true, noContextFiles: true }, owner);
  agents.stop(empty.agentId, owner);
  deadline = Date.now() + 8000;
  while (agents.host.alive(empty.agentId) && Date.now() < deadline) { agents.refresh(owner); await new Promise(r => setTimeout(r, 100)); }
  assert.deepEqual(agents.cycles(empty.agentId, owner), []);
});
