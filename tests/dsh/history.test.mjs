import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessage, createUserMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import { flushDshAgent } from "../../dist/integrations/dsh/session.js";
import { DshHistory, projectDshHistory } from "../../dist/integrations/dsh/history.js";
import { dshHistorySummarizer } from "../../dist/integrations/dsh/history-summary.js";
import { HistoryService, indexHistory } from "../../dist/services/history/history-service.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { PiHistory, projectHistory } from "../../dist/integrations/pi/history.js";

// Durable protocol fixtures through public Session APIs. No model or tool execution is substituted.
function question(session, text, source = { kind: "user" }) {
  return session.append("user/message", createUserMessage({ content: [{ type: "text", text }], source }), { surfaceOp: "append" });
}
function answer(session, turn, step, text, finish = "stop", interrupted = false) {
  return session.append("assistant/message", { turn, step, interrupted,
    message: createAssistantMessage({ content: [{ type: "text", text }], source: { provider: "deepseek-official", model: "deepseek-flash" } }),
    stream: [{ type: "text-chunks", index: 0, time0: Date.now(), dt: [0], texts: [text] },
      { type: "chunk", time: Date.now(), chunk: { type: "finish", reason: { kind: finish } } }],
  }, { surfaceOp: "append" });
}
function exchange(session, turn, prompt, text, { finish = "stop", interrupted = false, source, reason = { kind: "completed" } } = {}) {
  session.append("turn/start", { turn }); session.append("step/start", { turn, step: 1 });
  question(session, prompt, source); answer(session, turn, 1, text, finish, interrupted);
  session.append("step/end", { turn, step: 1 }); session.append("turn/end", { turn, reason });
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-history-"))), root = join(temp, "workspace");
  await mkdir(root);
  const host = await dshHost(join(temp, "native"));
  t.after(async () => { try { await host.close(); } finally { await rm(temp, { recursive: true, force: true }); } });
  return { temp, root, host };
}

test("dsh cold history keeps steering, partial answers and forks within their workspace and omits tool records", async t => {
  const { root, temp, host } = await fixture(t), foreign = join(temp, "foreign"); await mkdir(foreign);
  const main = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } }), session = main.agent.session;
  const hidden = randomUUID();
  session.append("turn/start", { turn: 1 }); session.append("step/start", { turn: 1, step: 1 }); question(session, "第一问");
  session.append("assistant/message", { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: "text", text: hidden }, { type: "tool-call", id: "recorded-read", name: "read", arguments: "{}" }],
    source: { provider: "deepseek-official", model: "deepseek-flash" } }) }, { surfaceOp: "append" });
  session.append("tool/call", { turn: 1, step: 1, callId: "recorded-read", name: "read", arguments: "{}" });
  session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: "recorded-read", content: [{ type: "text", text: hidden }], isError: false }) }, { surfaceOp: "append" });
  session.append("step/end", { turn: 1, step: 1 }); session.append("step/start", { turn: 1, step: 2 });
  question(session, "补充要求"); answer(session, 1, 2, "完整回答");
  session.append("step/end", { turn: 1, step: 2 }); session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  exchange(session, 2, "截断的问题", "部分回答", { finish: "max-tokens" });
  exchange(session, 3, "中断的问题", "中断前的文本", { interrupted: true, reason: { kind: "aborted", cause: { kind: "user" } } });
  exchange(session, 4, "通知上下文", "通知轮次", { source: { kind: "pbot-results", form: "notice", summary: "通知", keys: [] } });
  await flushDshAgent(main.agent);
  const original = session.snapshotEvents();
  const fork = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root, isSeeded: true },
    seed: original, inheritedEventCount: original.length });
  const child = await host.ctx.agents.create({ sessionId: randomUUID(), parentAgent: main.agent,
    meta: { cwd: foreign, parentSession: main.agent.id, origin: "subagent" } });
  exchange(child.agent.session, 1, "关联专家的问题", "专家答复", { source: { kind: "pbot-input", form: "relay",
    requestId: randomUUID(), generation: randomUUID(), parentSessionId: main.agent.id } });
  child.agent.session.append("turn/start", { turn: 2 }); child.agent.session.append("step/start", { turn: 2, step: 1 });
  question(child.agent.session, "未结束的问题"); answer(child.agent.session, 2, 1, "未结束的答复");
  assert.equal(projectDshHistory(child.agent.session.header, child.agent.session.snapshotEvents()).branches[0][1].completed, false);
  const other = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: foreign } }); await flushDshAgent(other.agent);
  const otherChild = await host.ctx.agents.create({ sessionId: randomUUID(), parentAgent: other.agent,
    meta: { cwd: root, parentSession: other.agent.id, origin: "subagent" } });
  exchange(otherChild.agent.session, 1, "其他工作区的专家", "不应收录");
  for (const handle of [child, fork, otherChild, main, other]) { await flushDshAgent(handle.agent); await handle.dispose(); }
  const source = new DshHistory(host.ctx, root), result = await source.scan({ host: "dsh" });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sessions.map(value => value.sessionId).sort(), [main.agent.id, child.agent.id, fork.agent.id].sort());
  const projected = result.sessions.find(value => value.sessionId === main.agent.id);
  assert.equal(projected.branches.length, 1); assert.equal(projected.branches[0].length, 3);
  assert.deepEqual(projected.branches[0].map(value => value.completed), [true, false, false]);
  assert.equal(projected.branches[0][0].entryIds.length, 3);
  assert.ok(projected.branches[0][0].text.includes("补充要求"));
  assert.ok(projected.branches[0][1].text.includes("部分回答"));
  assert.ok(projected.branches[0].every(value => !value.text.includes(hidden)));
  const files = new HistoryFiles(join(root, ".dsh/pbot/history"), "dsh"), service = new HistoryService(root, files, source);
  t.after(() => service.close()); await service.refresh({ host: "dsh" });
  assert.equal(service.search().total, 3); assert.equal(service.search({ query: hidden }).total, 0);
  assert.ok(files.list().every(value => value.id.startsWith("dsh-")));
  const hit = service.search({ query: "补充要求", sessionId: main.agent.id }).matches[0], read = service.read(hit.id);
  assert.equal(read.source.host, "dsh"); assert.equal(read.source.sessionId, main.agent.id);
  assert.deepEqual(read.source.entryIds, projected.branches[0][0].entryIds);
  assert.ok(read.parents.every(value => value.host === "dsh"));
  assert.equal(host.ctx.agents.roots().length, 0);
  assert.deepEqual((await host.ctx.sessionQuery.readSession(main.agent.id)).events, original);
  await assert.rejects(source.scan({ directory: root }));
});

test("both hosts query equal native ids independently, preserve peer archives and isolate damaged sources", async t => {
  const { root, host } = await fixture(t), manager = SessionManager.create(root, join(root, "pi-native"));
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 1; i <= 4; i++) {
    manager.appendMessage({ role: "user", content: "Pi 问题 " + i, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", timestamp: Date.now(), usage,
      content: [{ type: "text", text: "归档答复🙂".repeat(100) }], stopReason: "stop" });
  }
  const original = await readFile(manager.getSessionFile(), "utf8"), piFiles = new HistoryFiles(join(root, ".pi/pbot/history"));
  const saved = { ...indexHistory(projectHistory(original)), file: join(root, "missing-original.jsonl") };
  const summary = saved.nodes.find(value => value.kind === "summary"); summary.text = "已有摘要"; summary.ready = true; piFiles.save(saved);
  const piPath = join(piFiles.directory, saved.id + ".json"), piBytes = await readFile(piPath, "utf8");
  const handle = await host.ctx.agents.create({ sessionId: manager.getSessionId(), meta: { cwd: root } });
  for (let turn = 1; turn <= 4; turn++) exchange(handle.agent.session, turn, "dsh 问题 " + turn, "原生答复");
  await flushDshAgent(handle.agent); await handle.dispose();
  const dshFiles = new HistoryFiles(join(root, ".dsh/pbot/history"), "dsh");
  const service = new HistoryService(root, dshFiles, new DshHistory(host.ctx, root), undefined, piFiles);
  t.after(() => service.close()); await service.refresh({ host: "dsh" });
  const canceled = new AbortController(); canceled.abort();
  const abandoned = service.refresh({ host: "dsh" }, canceled.signal), continued = service.refresh({ host: "dsh" });
  await assert.rejects(abandoned, { name: "AbortError" }); await continued;
  assert.equal(service.search({ sessionId: manager.getSessionId() }).total, 2);
  for (const host of ["pi", "dsh"]) assert.equal(service.search({ host, sessionId: manager.getSessionId() }).total, 1);
  assert.equal(service.read(summary.id, 0, 12000, 0, "pi").text, "已有摘要");
  const child = service.read(summary.id).children[0], first = service.read(child.id, 0, 33);
  let text = first.text, next = first.nextOffset;
  while (next !== null) { const page = service.read(child.id, next, 33); text += page.text; next = page.nextOffset; }
  assert.equal(text, service.read(child.id).text); assert.equal(first.source.host, "pi");
  assert.equal(await readFile(piPath, "utf8"), piBytes);
  const dshRecord = dshFiles.list()[0], dshPath = join(dshFiles.directory, dshRecord.id + ".json"), dshBytes = await readFile(dshPath, "utf8");
  await writeFile(piPath, "invalid JSON"); await service.refresh({ host: "dsh" });
  assert.equal(service.warnings.length, 1); assert.equal(service.search({ host: "dsh" }).total, 1);
  await writeFile(piPath, piBytes); await writeFile(dshPath, "invalid JSON"); await service.refresh({ host: "dsh" });
  assert.equal(service.warnings.length, 1); assert.equal(service.search({ host: "pi" }).total, 1);
  await writeFile(dshPath, dshBytes);
  const pi = new HistoryService(root, piFiles, new PiHistory(root), undefined, dshFiles); t.after(() => pi.close());
  await pi.refresh({ directory: manager.getSessionDir(), file: manager.getSessionFile() });
  assert.deepEqual(pi.warnings, []); assert.equal(pi.search().total, 2);
  assert.equal(pi.search({ host: "pi" }).matches[0].id, saved.id);
  assert.equal(pi.read(summary.id).text, "已有摘要");
  assert.equal(await readFile(dshPath, "utf8"), dshBytes); assert.equal(await readFile(manager.getSessionFile(), "utf8"), original);
});

test("a real missing dsh provider leaves summaries pending and exposes the failure without changing original history", async t => {
  const { root, host } = await fixture(t), handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
  for (let turn = 1; turn <= 4; turn++) exchange(handle.agent.session, turn, "待整理问题 " + turn, "已有答复");
  await flushDshAgent(handle.agent);
  const source = projectDshHistory(handle.agent.session.header, handle.agent.session.snapshotEvents());
  const files = new HistoryFiles(join(root, ".dsh/pbot/history"), "dsh"), record = indexHistory(source, undefined, "dsh"); files.save(record);
  const path = join(files.directory, record.id + ".json"), original = await readFile(path, "utf8");
  const service = new HistoryService(root, files, new DshHistory(host.ctx, root)); t.after(() => service.close());
  await service.refresh({ host: "dsh" }); assert.equal(service.status.pending, 1);
  await assert.rejects(service.organize(dshHistorySummarizer(host.ctx, { provider: "not-configured", model: "none" }, handle.agent.id), new AbortController().signal));
  assert.equal(service.status.pending, 1); assert.equal(service.status.organizing, false); assert.equal(service.warnings.length, 1);
  await service.refresh({ host: "dsh" }); assert.equal(service.warnings.length, 1);
  assert.equal(await readFile(path, "utf8"), original);
  await handle.dispose();
});
