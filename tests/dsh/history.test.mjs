import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { DshHistoryWork } from "../../dist/extension/dsh/history.js";
import { createAssistantMessage, createUserMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import { flushDshAgent } from "../../dist/integrations/dsh/session.js";
import { DshHistory, projectDshHistory } from "../../dist/integrations/dsh/history.js";
import { dshHistorySummarizer } from "../../dist/integrations/dsh/history-summary.js";
import { HistoryService } from "../../dist/services/history/history-service.js";
import { historySummaries, historyView, indexHistory } from "../../dist/services/history/history-index.js";
import { assertArchiveReadable, legacyArchive } from "../helpers/history-archive.mjs";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { acpHistorySessions } from "../../dist/storage/acp-history.js";
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
  const files = new HistoryFiles(join(root, ".pbot/history"), "dsh"), service = new HistoryService(root, files, source);
  t.after(() => service.close()); await service.refresh({ host: "dsh" });
  assert.equal(service.search().total, 3); assert.equal(service.search({ query: hidden }).total, 0);
  assert.ok(files.list().every(({ raw }) => raw.host === "dsh"));
  const hit = service.search({ query: "补充要求", sessionId: main.agent.id }).matches[0], read = service.read(hit.id);
  assert.equal(read.source.host, "dsh"); assert.equal(read.source.sessionId, main.agent.id);
  assert.deepEqual(read.source.entryIds, projected.branches[0][0].entryIds);
  assert.ok(read.parents.every(value => value.host === "dsh"));
  assert.equal(host.ctx.agents.roots().length, 0);
  assert.deepEqual((await host.ctx.sessionQuery.readSession(main.agent.id)).events, original);
  await assert.rejects(source.scan({ host: "pi", directory: root }));
  await assert.rejects(source.scan({ host: "claude", sessionId: main.agent.id }));
});

for (const starter of ["pi", "dsh"]) test(`${starter} refresh migrates its own native archive and only reads peer archives`, async t => {
  const { temp, root, host } = await fixture(t), manager = SessionManager.create(root, join(root, "pi-native"));
  const copy = join(temp, "copied-workspace"); await mkdir(copy);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const handle = await host.ctx.agents.create({ sessionId: manager.getSessionId(), meta: { cwd: root } });
  for (let i = 1; i <= 16; i++) {
    manager.appendMessage({ role: "user", content: "Pi 问题 " + i, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", timestamp: Date.now(), usage,
      content: [{ type: "text", text: "Pi 答复 " + i }], stopReason: i === 16 ? "length" : "stop" });
    exchange(handle.agent.session, i, "dsh 问题 " + i, "dsh 答复 " + i, { finish: i === 16 ? "max-tokens" : "stop" });
  }
  await flushDshAgent(handle.agent);
  const dshOriginal = handle.agent.session.snapshotEvents(); await handle.dispose();
  const piOriginal = await readFile(manager.getSessionFile(), "utf8");
  const sources = { pi: new PiHistory(root), dsh: new DshHistory(host.ctx, root) };
  const locations = { pi: { host: "pi", directory: manager.getSessionDir(), file: manager.getSessionFile() }, dsh: { host: "dsh" } };
  const expected = new Map();
  for (const source of ["pi", "dsh"]) {
    const scanned = await sources[source].scan(locations[source]); assert.deepEqual(scanned.warnings, []);
    const record = historyView(indexHistory(scanned.sessions[0], undefined, source));
    for (const summary of record.nodes.filter(node => node.kind === "summary")) {
      summary.text = summary.level === 2 ? "已有摘要 " + source : "下级摘要 " + summary.id;
      summary.ready = true;
    }
    assert.equal(record.nodes.find(node => node.level === 2).completed, false);
    const { path } = await legacyArchive(copy, record);
    expected.set(source, { record, path, bytes: await readFile(path) });
  }
  const files = new HistoryFiles(join(copy, ".pbot/history"), starter);
  const other = new HistoryFiles(files.directory, starter === "pi" ? "dsh" : "pi");
  const source = starter === "pi" ? new PiHistory(copy) : new DshHistory(host.ctx, copy);
  const service = new HistoryService(copy, files, source, [other]); t.after(() => service.close());
  const offline = starter === "pi" ? { host: "pi", directory: join(copy, "missing-native") } : { host: "dsh" };
  const online = starter === "pi" ? locations.pi : { host: "dsh", sessionId: handle.agent.id };
  await service.refresh(offline);
  assert.deepEqual(service.warnings, []); assert.equal(service.search().total, 2);
  for (const { record } of expected.values()) {
    assertArchiveReadable(service, record);
    const hit = service.search({ host: record.host, query: "已有摘要" });
    assert.equal(hit.total, 1); assert.equal(hit.matches[0].id, record.nodes.find(node => node.level === 2).id);
  }
  const own = expected.get(starter), peer = expected.get(other.host);
  const rawPath = join(files.directory, "raw", own.record.id + ".json"), derivedPath = join(files.directory, "summary", own.record.id + ".json");
  assert.deepEqual(JSON.parse(await readFile(rawPath, "utf8")), files.list()[0].raw);
  assert.ok((await readFile(derivedPath, "utf8")).includes("已有摘要 " + starter));
  await assert.rejects(stat(join(copy, "." + starter, "pbot")), { code: "ENOENT" });
  await assert.rejects(stat(join(files.directory, "raw", peer.record.id + ".json")), { code: "ENOENT" });
  await assert.rejects(stat(join(files.directory, "summary", peer.record.id + ".json")), { code: "ENOENT" });
  assert.deepEqual(await readFile(peer.path), peer.bytes);

  await service.refresh(online);
  const [restored, derived] = await Promise.all([readFile(rawPath), readFile(derivedPath)]);
  await service.refresh(online);
  assert.deepEqual(service.warnings, []); assert.equal(service.search().total, 2);
  for (const { record } of expected.values()) assertArchiveReadable(service, record);
  assert.deepEqual(await readFile(rawPath), restored); assert.deepEqual(await readFile(derivedPath), derived);
  assert.deepEqual(await readFile(peer.path), peer.bytes);
  assert.equal(await readFile(manager.getSessionFile(), "utf8"), piOriginal);
  assert.deepEqual((await host.ctx.sessionQuery.readSession(handle.agent.id)).events, dshOriginal);
});

test("both hosts query equal native ids independently, preserve peer archives and isolate damaged sources", async t => {
  const { root, host } = await fixture(t), manager = SessionManager.create(root, join(root, "pi-native"));
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 1; i <= 4; i++) {
    manager.appendMessage({ role: "user", content: "Pi 问题 " + i, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", timestamp: Date.now(), usage,
      content: [{ type: "text", text: "归档答复🙂".repeat(100) }], stopReason: "stop" });
  }
  const original = await readFile(manager.getSessionFile(), "utf8"), piFiles = new HistoryFiles(join(root, ".pbot/history"));
  const saved = indexHistory(projectHistory(original)), piView = historyView(saved);
  const summary = piView.nodes.find(value => value.kind === "summary"); summary.text = "已有摘要"; summary.ready = true;
  piFiles.saveRaw(saved); piFiles.saveSummaries(saved, historySummaries(piView));
  const piPath = join(piFiles.directory, "raw", saved.id + ".json"), piBytes = await readFile(piPath, "utf8");
  const piDerived = join(piFiles.directory, "summary", saved.id + ".json"), piSummaryBytes = await readFile(piDerived);
  const handle = await host.ctx.agents.create({ sessionId: manager.getSessionId(), meta: { cwd: root } });
  for (let turn = 1; turn <= 4; turn++) exchange(handle.agent.session, turn, "dsh 问题 " + turn, "原生答复");
  await flushDshAgent(handle.agent); await handle.dispose();
  const dshFiles = new HistoryFiles(join(root, ".pbot/history"), "dsh");
  const service = new HistoryService(root, dshFiles, new DshHistory(host.ctx, root), [piFiles]);
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
  assert.equal(await readFile(piPath, "utf8"), piBytes); assert.deepEqual(await readFile(piDerived), piSummaryBytes);
  const [{ raw: dshRecord }] = dshFiles.list(), dshPath = join(dshFiles.directory, "raw", dshRecord.id + ".json"), dshBytes = await readFile(dshPath, "utf8");
  assert.throws(() => piFiles.saveRaw(dshRecord)); assert.throws(() => dshFiles.saveRaw(saved));
  assert.throws(() => piFiles.saveSummaries(dshRecord, [])); assert.throws(() => dshFiles.saveSummaries(saved, []));
  assert.equal(piFiles.list().length, 1); assert.equal(dshFiles.list().length, 1);
  await writeFile(piPath, "invalid JSON"); await service.refresh({ host: "dsh" });
  assert.equal(service.warnings.length, 1); assert.equal(service.search({ host: "dsh" }).total, 1);
  await writeFile(piPath, piBytes); await writeFile(dshPath, "invalid JSON"); await service.refresh({ host: "dsh" });
  assert.equal(service.warnings.length, 1); assert.equal(service.search({ host: "pi" }).total, 1);
  await writeFile(dshPath, dshBytes);
  const pi = new HistoryService(root, piFiles, new PiHistory(root), [dshFiles]); t.after(() => pi.close());
  await pi.refresh({ host: "pi", directory: manager.getSessionDir(), file: manager.getSessionFile() });
  assert.deepEqual(pi.warnings, []); assert.equal(pi.search().total, 2);
  assert.equal(pi.search({ host: "pi" }).matches[0].id, saved.id);
  assert.equal(pi.read(summary.id).text, "已有摘要");
  assert.equal(await readFile(dshPath, "utf8"), dshBytes); assert.equal(await readFile(manager.getSessionFile(), "utf8"), original);
});

test("dsh ignores related expert ids that are not native dsh sessions", async t => {
  const { root, host } = await fixture(t), handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
  exchange(handle.agent.session, 1, "工作区问题", "工作区答复");
  await flushDshAgent(handle.agent); await handle.dispose();
  const acpMember = randomUUID(), stale = "session-" + randomUUID();
  const source = new DshHistory(host.ctx, root, () => [acpMember, stale]), result = await source.scan({ host: "dsh" });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sessions.map(value => value.sessionId), [handle.agent.id]);
});

test("ACP backend session IDs exclude fresh and already archived members across hosts", async t => {
  const { root, host, temp } = await fixture(t), controls = { pi: join(temp, "pi-members"), dsh: join(temp, "dsh-members") };
  const native = SessionManager.create(root, join(root, "pi-native")), sessionId = native.getSessionId();
  native.appendMessage({ role: "user", content: "Pi 输入", timestamp: Date.now() });
  const handle = await host.ctx.agents.create({ sessionId, meta: { cwd: root } });
  for (let i = 1; i <= 4; i++) exchange(handle.agent.session, i, "成员问题 " + i, "成员回答");
  await flushDshAgent(handle.agent); await handle.dispose();
  const piFiles = new HistoryFiles(join(root, ".pbot/history")), dshFiles = new HistoryFiles(piFiles.directory, "dsh");
  const members = () => acpHistorySessions(controls);
  const pi = new HistoryService(root, piFiles, new PiHistory(root), [dshFiles], members);
  const dsh = new HistoryService(root, dshFiles, new DshHistory(host.ctx, root), [piFiles], members);
  t.after(() => Promise.all([pi.close(), dsh.close()]));
  const piLocation = { host: "pi", directory: native.getSessionDir(), file: native.getSessionFile() };
  // Pi's SDK persists its reserved session after the first assistant message.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  native.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", timestamp: Date.now(), usage,
    content: [{ type: "text", text: "Pi 回答" }], stopReason: "stop" });
  const dshLocation = { host: "dsh", sessionId };
  await dsh.refresh(dshLocation);
  const [old] = dshFiles.list(); assert.equal(dsh.status.pending, 1);
  async function bind(owner, backend, id) {
    const directory = join(controls[owner], randomUUID()); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "acp-session.json"), JSON.stringify({ host: "acp", backend, sessionId: id, command: process.execPath, args: [] }));
  }
  await bind("pi", "dsh", sessionId); await bind("dsh", "pi", null);
  const dshScan = await new DshHistory(host.ctx, root, () => [sessionId]).scan(dshLocation, undefined, members().ids.dsh);
  assert.deepEqual(dshScan, { sessions: [], warnings: [] });
  await pi.refresh(piLocation); await dsh.refresh(dshLocation);
  for (const service of [pi, dsh]) {
    assert.deepEqual(service.warnings, []);
    assert.deepEqual(service.search({ sessionId }).matches.map(hit => hit.host), ["pi"]);
    assert.throws(() => service.read(old.raw.exchanges[0].id));
  }
  assert.equal(dsh.status.pending, 0);
  await dsh.organize(dshHistorySummarizer(host.ctx, { provider: "not-configured", model: "none" }, sessionId), new AbortController().signal);
  assert.deepEqual(dshFiles.list(), [old]);
  const fresh = new HistoryFiles(join(temp, "fresh"));
  await bind("dsh", "pi", sessionId);
  const piSource = new PiHistory(root, () => [piLocation.file]);
  assert.deepEqual(await piSource.scan(piLocation, undefined, members().ids.pi), { sessions: [], warnings: [] });
  const clean = new HistoryService(root, fresh, piSource, [], members); t.after(() => clean.close());
  await clean.refresh(piLocation);
  assert.deepEqual(clean.warnings, []); assert.equal(clean.search().total, 0); assert.deepEqual(fresh.list(), []);
});

test("dsh discovers Pi-owned ACP sessions with a file URL for the Pi agent directory", async t => {
  const { root, host, temp } = await fixture(t);
  const prior = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, DSH_HOME: process.env.DSH_HOME };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: pathToFileURL(join(temp, "Pi home")).href, DSH_HOME: join(temp, "dsh-home") });
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
  exchange(handle.agent.session, 1, "成员问题", "成员回答"); await flushDshAgent(handle.agent); await handle.dispose();
  const directory = join(getAgentDir(), "pbot/subagents", randomUUID()); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "acp-session.json"), JSON.stringify({ host: "acp", backend: "dsh", sessionId: handle.agent.id, command: process.execPath, args: [] }));
  const work = new DshHistoryWork(host.ctx, root); t.after(() => work.close());
  await work.service.refresh({ host: "dsh", sessionId: handle.agent.id });
  assert.deepEqual(work.service.warnings, []); assert.equal(work.service.search().total, 0);
  assert.deepEqual(new HistoryFiles(join(root, ".pbot/history"), "dsh").list(), []);
});

test("dsh replaces a tool-phase observation while retaining a later interrupted turn", async t => {
  const { root, host } = await fixture(t), handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
  const session = handle.agent.session;
  for (let turn = 1; turn <= 3; turn++) exchange(session, turn, "完成问题 " + turn, "完成答复 " + turn);
  session.append("turn/start", { turn: 4 }); session.append("step/start", { turn: 4, step: 1 });
  const user = question(session, "等待工具的问题"), partial = answer(session, 4, 1, "工具阶段的部分文本", "tool-calls");
  const files = new HistoryFiles(join(root, ".pbot/history"), "dsh"), service = new HistoryService(root, files, new DshHistory(host.ctx, root));
  t.after(() => service.close());
  await flushDshAgent(handle.agent); await service.refresh({ host: "dsh" });
  const [{ raw }] = files.list(), archived = historyView(raw), old = archived.nodes.find(node => node.kind === "summary");
  old.text = "部分阶段摘要"; old.ready = true; files.saveSummaries(raw, historySummaries(archived));
  session.append("step/end", { turn: 4, step: 1 }); session.append("step/start", { turn: 4, step: 2 });
  const final = answer(session, 4, 2, "完整最终答复");
  session.append("step/end", { turn: 4, step: 2 }); session.append("turn/end", { turn: 4, reason: { kind: "completed" } });
  exchange(session, 5, "独立中断的问题", "中断前正文", { interrupted: true, reason: { kind: "aborted", cause: { kind: "user" } } });
  exchange(session, 6, "后续问题", "后续最终答复");
  await flushDshAgent(handle.agent);
  const native = session.snapshotEvents(); await service.refresh({ host: "dsh" });
  const [{ raw: updated }] = files.list(), exchanges = updated.exchanges;
  assert.equal(exchanges.length, 6);
  assert.equal(exchanges.some(node => node.entryIds.at(-1) === "dsh:" + partial.seq), false);
  assert.deepEqual(exchanges.find(node => node.entryIds[0] === "dsh:" + user.seq).entryIds, ["dsh:" + user.seq, "dsh:" + final.seq]);
  assert.equal(exchanges.filter(node => !node.completed).length, 1);
  assert.equal(service.search({ query: "部分阶段摘要" }).total, 0);
  assert.equal(service.search({ query: "中断前正文" }).total, 1);
  assert.deepEqual(session.snapshotEvents(), native);
  await handle.dispose();
});

test("a real missing dsh provider leaves summaries pending and exposes the failure without changing original history", async t => {
  const { root, host } = await fixture(t), handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
  for (let turn = 1; turn <= 4; turn++) exchange(handle.agent.session, turn, "待整理问题 " + turn, "已有答复");
  await flushDshAgent(handle.agent);
  const files = new HistoryFiles(join(root, ".pbot/history"), "dsh");
  const service = new HistoryService(root, files, new DshHistory(host.ctx, root)); t.after(() => service.close());
  await service.refresh({ host: "dsh" }); assert.equal(service.status.pending, 1);
  const [{ raw }] = files.list(), path = join(files.directory, "raw", raw.id + ".json"), original = await readFile(path, "utf8");
  const summarize = dshHistorySummarizer(host.ctx, { provider: "not-configured", model: "none" }, handle.agent.id);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.organize(summarize, cancelled.signal), { name: "AbortError" });
  assert.equal(service.status.organizing, false); assert.deepEqual(service.warnings, []);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(service.organize(summarize, new AbortController().signal));
  assert.equal(service.status.pending, 1); assert.equal(service.status.organizing, false); assert.equal(service.warnings.length, 1);
  await service.refresh({ host: "dsh" }); assert.equal(service.warnings.length, 1);
  assert.equal(await readFile(path, "utf8"), original);
  await handle.dispose();
});
