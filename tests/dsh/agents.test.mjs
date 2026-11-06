import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, access, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Bash from "@deepseek-ai/dsh-bash-local";
import * as FileTools from "@deepseek-ai/dsh-tool-fs";
import * as SkillTools from "@deepseek-ai/dsh-tool-skill";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import * as pbot from "../../dist/dsh.js";
import { preparePythonFailure } from "../helpers/python-home.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-agents-")));
  const previous = { DSH_HOME: process.env.DSH_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  const { environment } = await preparePythonFailure(join(root, "user"));
  Object.assign(process.env, environment, { DSH_HOME: join(root, "home") });
  const host = await dshHost(join(root, "sessions"));
  t.after(async () => {
    try { await host.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(root, { recursive: true, force: true });
    }
  });
  await host.ctx.plugin(SkillTools);
  const extension = await host.ctx.plugin(pbot), parents = [];
  for (const name of ["a", "b"]) {
    const cwd = join(root, name); await mkdir(cwd);
    if (name === "a") {
      const skill = join(cwd, ".agents/skills/local-check"); await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "---\nname: local-check\ndescription: Workspace-local inspection.\n---\nInspect local inputs.\n");
    }
    // No adapter is installed: this is a real missing-provider failure, not a model substitute.
    parents.push(await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: "not-configured", model: "none" } }));
  }
  const call = async (agent, name, args) => {
    const result = await host.ctx.tools.execute({ agent, signal: new AbortController().signal,
      calls: [{ type: "tool-call", id: randomUUID(), name, arguments: JSON.stringify(args) }] });
    return result.results[0].result;
  };
  const run = async (agent, name, args) => {
    const result = await call(agent, name, args);
    assert.equal(result.isError, false, JSON.stringify(result)); return result.value;
  };
  return { root, host, extension, parents, call, run };
}
async function until(read, accept) {
  const deadline = Date.now() + 6000;
  do { const value = await read(); if (accept(value)) return value; await delay(20); } while (Date.now() < deadline);
  assert.fail("native operation did not settle");
}

test("native expert tools preserve owner, original workspace, empty sessions and explicit resume", async t => {
  const { root, host, parents, call, run } = await fixture(t);
  const [first, second] = parents.map(handle => handle.agent);
  const bad = await call(first, "pbot_agent", { action: "start", noExtensions: true });
  assert.equal(bad.isError, true);
  assert.deepEqual((await run(first, "pbot_agent", { action: "list" })).agents, []);
  await host.ctx.workingDirectory.set(first, join(root, "b"));
  const expert = await run(first, "pbot_agent", { action: "start", name: "empty", noSkills: true });
  const other = await run(second, "pbot_agent", { action: "start", name: "other" });
  assert.equal(expert.cwd, join(root, "a"));
  let native = host.ctx.agents.get(expert.agentId);
  const names = host.ctx.tools.definitions(native).map(tool => tool.name);
  for (const forbidden of ["pbot_agent", "pbot_team", "pbot_history", "skill"]) assert.equal(names.includes(forbidden), false);
  assert.ok(names.includes("pbot_team_message"));
  const skills = await host.ctx.skills.list({ scope: first, cwd: join(root, "a") });
  assert.ok(skills.some(skill => skill.name === "local-check" && skill.provider === "pbot"));
  assert.ok(skills.some(skill => skill.name === "provider-connections" && skill.provider === "pbot"));
  assert.equal((await host.ctx.skills.list({ scope: second, cwd: join(root, "b") })).some(skill => skill.name === "local-check"), false);
  const withSkills = host.ctx.agents.get(other.agentId);
  assert.ok(host.ctx.tools.definitions(withSkills).some(tool => tool.name === "skill"));
  assert.equal((await call(withSkills, "skill", { name: "provider-connections" })).isError, false);
  const originalHeader = { ...native.session.header };
  assert.equal(native.session.snapshotEvents().some(event => event.type === "turn/start"), false);
  assert.equal((await call(second, "pbot_agent", { action: "read", agentId: expert.agentId })).isError, true);
  await run(first, "pbot_agent", { action: "stop", agentId: expert.agentId });
  await until(() => host.ctx.agents.get(expert.agentId), value => value === undefined);
  const before = await host.ctx.sessionQuery.readSession(expert.agentId);
  assert.equal(before.events.some(event => event.type === "turn/start"), false);
  const launchPath = join(root, "home/pbot/subagents", expert.agentId, "launch.json"), launch = await readFile(launchPath, "utf8");
  const occupied = await host.ctx.agents.resume({ resumeSessionId: expert.agentId, parentAgent: first });
  try {
    assert.equal((await call(first, "pbot_agent", { action: "resume", agentId: expert.agentId, message: "Must not replace an active native owner" })).isError, true);
    assert.equal(host.ctx.agents.get(expert.agentId), occupied.agent);
    assert.equal(await readFile(launchPath, "utf8"), launch);
    assert.equal(occupied.agent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
  } finally { await occupied.dispose(); }
  const resumed = await run(first, "pbot_agent", { action: "resume", agentId: expert.agentId, message: "Only this new request" });
  native = host.ctx.agents.get(expert.agentId);
  assert.deepEqual(native.session.header, originalHeader);
  assert.deepEqual(native.model.current(), { provider: "not-configured", model: "none" });
  const failed = await until(() => run(first, "pbot_agent", { action: "status", agentId: expert.agentId }), value => value.cycle?.state === "failed");
  assert.deepEqual(failed.cycle.requestIds, [resumed.requestId]);
  assert.equal(failed.cycle.source, "parent");
  const read = await run(first, "pbot_agent", { action: "read", agentId: expert.agentId, cycleId: failed.cycle.cycleId });
  assert.equal(read.report, "");
  const events = (await host.ctx.sessionQuery.readSession(expert.agentId)).events;
  assert.equal(events.filter(event => event.type === "turn/start").length, 1);
  assert.deepEqual(events.filter(event => event.type === "user/message" && event.data.source.kind === "pbot-input").map(event => event.data.source.requestId), [resumed.requestId]);
  assert.equal(events.some(event => event.type === "assistant/message"), false);
  const history = await run(first, "pbot_history", { action: "search", query: "Only this new request" });
  assert.equal(history.total, 1); assert.equal(history.matches[0].host, "dsh");
  const archived = await run(first, "pbot_history", { action: "read", id: history.matches[0].id, host: "dsh" });
  assert.equal(archived.node.source.sessionId, expert.agentId); assert.equal(archived.node.completed, false);
  assert.equal(native.session.snapshotEvents().filter(event => event.type === "turn/start").length, 1);
  const notices = () => first.session.snapshotEvents().filter(event => event.type === "user/message" && event.data.source.kind === "pbot-results");
  assert.equal(notices().length, 0);
  first.steer(createUserMessage({ content: [{ type: "text", text: "Review the existing result without resubmitting work." }], source: { kind: "user" } }));
  await first.whenIdle();
  assert.equal(notices().flatMap(event => event.data.source.keys).filter(key => key === expert.agentId + ":" + failed.cycle.cycleId).length, 1);
  assert.equal(native.session.snapshotEvents().filter(event => event.type === "turn/start").length, 1);
  const sameWorkspace = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: join(root, "a") } });
  await parents[0].dispose();
  assert.equal((await run(sameWorkspace.agent, "pbot_history", { action: "search", query: "Only this new request" })).total, 1);
  await sameWorkspace.dispose();
  assert.equal(host.ctx.agents.get(expert.agentId), undefined);
  assert.ok(host.ctx.agents.get(other.agentId));
  assert.equal((await run(second, "pbot_agent", { action: "status", agentId: other.agentId })).state, "idle");
});

test("native team tools retain public text and pause a finite batch after a real missing-provider failure", async t => {
  const { host, parents, call, run } = await fixture(t), parent = parents[0].agent;
  const members = [];
  for (const name of ["one", "two"]) members.push(await run(parent, "pbot_agent", { action: "start", name }));
  const team = await run(parent, "pbot_team", { action: "create", name: "review", brief: "Check the supplied information",
    members: members.map(member => ({ agentId: member.agentId, role: member.name })) });
  const text = "公开原文\n```\n第一条资料\n```";
  await run(parent, "pbot_team_message", { action: "post", teamId: team.teamId, text });
  const member = host.ctx.agents.get(members[0].agentId);
  assert.equal((await run(member, "pbot_team_message", { action: "read", teamId: team.teamId })).messages[0].text, text);
  assert.equal(member.session.snapshotEvents().some(event => event.type === "turn/start"), false);
  const started = await run(parent, "pbot_team", { action: "run", teamId: team.teamId,
    instruction: "Review this material", mode: "roundRobin", rounds: 2, timeoutSeconds: 30 });
  assert.equal(started.run.state, "running");
  assert.equal((await call(parent, "pbot_agent", { action: "send", agentId: member.id, message: "Private task" })).isError, true);
  const paused = await until(() => run(parent, "pbot_team", { action: "status", teamId: team.teamId }), value => value.run?.state === "paused");
  assert.equal(paused.run.scheduled, 1); assert.equal(paused.run.published, 0);
  assert.equal(paused.unresolved[0].state, "failed");
  assert.equal(paused.activeCount, 0);
  assert.equal((await run(parent, "pbot_team", { action: "read", teamId: team.teamId })).messages[0].text, text);
  const closed = await run(parent, "pbot_team", { action: "close", teamId: team.teamId });
  assert.equal(closed.closed, true);
  for (const expert of members) assert.ok(host.ctx.agents.get(expert.agentId));
});

test("native file tools enforce the original workspace for writes, edits and whole patches", async t => {
  const { root, host, parents, call, run } = await fixture(t), parent = parents[0].agent;
  await host.ctx.plugin(FileTools, { applyPatch: true });
  const expert = await run(parent, "pbot_agent", { action: "start" }), child = host.ctx.agents.get(expert.agentId);
  const inside = join(root, "a/note.txt"), outside = join(root, "outside.txt"), link = join(root, "a/link.txt");
  await writeFile(outside, "outside"); await symlink(outside, link);
  await run(child, "write", { file_path: "note.txt", content: "before" });
  await run(child, "read", { file_path: "note.txt" });
  await run(child, "edit", { file_path: "note.txt", old_string: "before", new_string: "after" });
  assert.equal(await readFile(inside, "utf8"), "after");
  assert.equal((await call(child, "edit", { file_path: "link.txt", old_string: "outside", new_string: "changed" })).isError, true);
  const move = "*** Begin Patch\n*** Update File: note.txt\n*** Move to: ../moved.txt\n@@\n-after\n+changed\n*** End Patch";
  assert.equal((await call(child, "apply_patch", { input: move })).isError, true);
  assert.equal(await readFile(inside, "utf8"), "after");
  await assert.rejects(access(join(root, "moved.txt")), { code: "ENOENT" });
  // An open native audit boundary exercises the real never/unavailable policies; no model is installed.
  parent.session.append("turn/start", { turn: 1 });
  assert.equal((await call(parent, "write", { file_path: link, content: "denied" })).isError, true);
  setApprovalPolicy(parent.session, "ask");
  const patch = "*** Begin Patch\n*** Update File: note.txt\n@@\n-after\n+changed\n*** Add File: ../unapproved.txt\n+outside\n*** End Patch";
  assert.equal((await call(parent, "apply_patch", { input: patch })).isError, true);
  parent.session.append("turn/end", { turn: 1, reason: { kind: "blocked" } });
  assert.deepEqual(parent.session.snapshotEvents().filter(event => event.type === "approval/decided").map(event => event.data.outcome), ["rejected", "unavailable"]);
  assert.equal(await readFile(outside, "utf8"), "outside");
  assert.equal(await readFile(inside, "utf8"), "after");
  await assert.rejects(access(join(root, "unapproved.txt")), { code: "ENOENT" });
  assert.equal(child.session.snapshotEvents().some(event => event.type === "approval/asked"), false);
});

test("parent and component disposal await real native Bash work while another parent's expert remains live", async t => {
  const { host, extension, parents, run } = await fixture(t);
  const shell = await host.ctx.plugin({ name: "pbot-test-shell", inject: ["tools"], async apply(ctx) {
    await ctx.plugin(Subprocess); await ctx.plugin(Bash);
  } });
  const access = await shell.ctx.plugin({ name: "pbot-test-shell-access", inject: ["shell"], apply() {} });
  const jobs = [];
  for (const parent of parents) {
    const expert = await run(parent.agent, "pbot_agent", { action: "start" });
    const agent = host.ctx.agents.get(expert.agentId);
    const started = Promise.withResolvers();
    const task = agent.runMaintenance(async signal => {
      const execution = await access.ctx.shell.execute(access.ctx.shell.resolve({ command: "printf ready; exec sleep 30", workdir: expert.cwd, signal }));
      started.resolve(execution);
      return execution.result();
    });
    const execution = await started.promise;
    await until(() => execution.observed.stdout.readFrom(0), value => value.text.includes("ready"));
    jobs.push({ task, execution, agent });
  }
  const team = await run(parents[0].agent, "pbot_team", { action: "create", name: "maintenance", brief: "Wait for native maintenance",
    members: [{ agentId: jobs[0].agent.id, role: "review" }] });
  await run(parents[0].agent, "pbot_team", { action: "run", teamId: team.teamId, instruction: "Review after the current native work", mode: "roundRobin", rounds: 1, timeoutSeconds: 30 });
  await until(() => run(parents[0].agent, "pbot_team", { action: "status", teamId: team.teamId }), value => value.run?.scheduled === 1);
  await delay(400);
  assert.equal(jobs[0].agent.status, "idle"); // Native maintenance deliberately retains this public status.
  assert.equal(jobs[0].execution.status, "running");
  assert.equal(jobs[0].agent.inbox.nextTurn.length + jobs[0].agent.inbox.nextStep.length, 0);
  assert.equal(jobs[0].agent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
  await parents[0].dispose();
  assert.equal((await jobs[0].task).aborted, true);
  assert.notEqual(jobs[0].execution.status, "running");
  assert.equal(host.ctx.agents.get(jobs[0].agent.id), undefined);
  assert.equal(jobs[1].execution.status, "running");
  assert.equal(host.ctx.agents.get(jobs[1].agent.id), jobs[1].agent);
  await extension.dispose();
  assert.equal((await jobs[1].task).aborted, true);
  assert.notEqual(jobs[1].execution.status, "running");
  assert.equal(host.ctx.agents.get(jobs[1].agent.id), undefined);
});
