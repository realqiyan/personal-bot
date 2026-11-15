import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { indexHistory, HistoryService } from "../../dist/services/history/history-service.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { PiHistory, projectHistory } from "../../dist/integrations/pi/history.js";
import { splitHistorySummary } from "../../dist/integrations/history-summary.js";
import { historyInput, historyResultSchema } from "../../dist/tools/history/contract.js";
import { schema } from "../../dist/common/validation.js";

// Persisted transcript fixtures through the real SDK; no model or simulated provider.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(manager, content, stopReason = "stop") {
  return manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1",
    content, stopReason, timestamp: Date.now(), usage });
}
function exchange(manager, question, answer) {
  manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
  return assistant(manager, [{ type: "text", text: answer }]);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  return { root, manager, file: manager.getSessionFile() };
}

async function legacyArchive(root, record) {
  const { host, ...value } = record, directory = join(root, "." + host, "pbot/history");
  await mkdir(directory, { recursive: true });
  const path = join(directory, record.id + ".json");
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
  return { directory, path, value };
}

test("history preserves Q&A and steering, omits tool logs, and merges only within native branches", async t => {
  const { manager, file } = await fixture(t);
  const hidden = randomUUID();
  manager.appendMessage({ role: "user", content: "第一问", timestamp: Date.now() });
  assistant(manager, [{ type: "text", text: hidden }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }], "toolUse");
  manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: hidden }], isError: false, timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "补充要求", timestamp: Date.now() });
  assistant(manager, [{ type: "text", text: "完整回答" }]);
  for (let i = 2; i <= 4; i++) exchange(manager, `问题 ${i}`, `回答 ${i}`);
  const fork = manager.getLeafId();
  for (let i = 5; i <= 8; i++) exchange(manager, `方案 A ${i}`, `结果 A ${i}`);
  manager.branch(fork);
  for (let i = 5; i <= 8; i++) exchange(manager, `方案 B ${i}`, `结果 B ${i}`);
  manager.appendMessage({ role: "user", content: "尚未完成", timestamp: Date.now() });
  assistant(manager, [{ type: "text", text: "部分回答" }], "aborted");
  const original = await readFile(file, "utf8"), source = projectHistory(original);
  assert.equal(source.branches.length, 2);
  const record = indexHistory(source), leaves = record.nodes.filter(node => node.kind === "exchange");
  assert.equal(leaves.length, 13);
  assert.equal(leaves.filter(node => !node.completed).length, 1);
  assert.ok(leaves.some(node => node.entryIds.length === 3 && node.text.includes("补充要求")));
  assert.ok(leaves.every(node => !node.text.includes(hidden)));
  const lookup = new Map(leaves.map(node => [node.id, node.text]));
  const summaries = record.nodes.filter(node => node.kind === "summary");
  assert.equal(summaries.length, 3);
  for (const summary of summaries) {
    assert.equal(summary.children.length, 4);
    const body = summary.children.map(id => lookup.get(id)).join("\n");
    assert.ok(!(body.includes("方案 A") && body.includes("方案 B")));
  }
  assert.equal(await readFile(file, "utf8"), original);
});

test("a reserved Pi filename is quiet; unreadable history still warns and keeps the saved exchanges", async t => {
  const { root, manager, file } = await fixture(t);
  manager.appendModelChange("openai", "gpt-4.1");
  const service = new HistoryService(root, new HistoryFiles(join(root, ".pbot/history")), new PiHistory(root));
  t.after(() => service.close());
  const location = { host: "pi", directory: manager.getSessionDir(), file };
  await service.refresh(location);
  assert.equal(service.search().total, 0);
  assert.deepEqual(service.warnings, []);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  exchange(manager, "落盘后的问题", "回答");
  await service.refresh(location);
  const hit = service.search({ query: "落盘后的问题" }).matches[0];
  const original = service.read(hit.id).text;
  await writeFile(file, "invalid JSON\n");
  await service.refresh(location);
  assert.equal(service.warnings.length, 1);
  assert.equal(service.read(hit.id).text, original);
});

test("Pi archives gain host, remove the old directory and retain summaries after copying and native relocation", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, `迁移问题 ${i}`, `回答 ${i}`);
  const original = await readFile(file, "utf8"), record = { ...indexHistory(projectHistory(original)), file };
  const summary = record.nodes.find(node => node.kind === "summary"), needle = randomUUID();
  summary.text = needle; summary.ready = true;
  const previous = await legacyArchive(root, record);
  const settings = join(root, ".pi/settings.json"); await writeFile(settings, "{}\n");
  const files = new HistoryFiles(join(root, ".pbot/history")), service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close());
  // Only the archive is available to this scan; relocation must not depend on the native session.
  const offline = { host: "pi", directory: join(root, "unavailable-native") };
  await service.refresh(offline);
  assert.deepEqual(service.warnings, []);
  assert.equal(service.search().total, 1);
  assert.equal(service.read(summary.id).text, needle);
  assert.deepEqual(JSON.parse(await readFile(join(files.directory, record.id + ".json"), "utf8")), { ...previous.value, host: "pi" });
  await assert.rejects(stat(previous.directory), { code: "ENOENT" });
  await assert.rejects(stat(join(root, ".pi/pbot")), { code: "ENOENT" });
  assert.equal(await readFile(settings, "utf8"), "{}\n");
  await service.refresh(offline);
  assert.deepEqual(service.warnings, []); assert.equal(service.search().total, 1);

  const copiedRoot = join(root, "another-machine"), copiedFiles = new HistoryFiles(join(copiedRoot, ".pbot/history"));
  await cp(files.directory, copiedFiles.directory, { recursive: true });
  const copied = new HistoryService(copiedRoot, copiedFiles, new PiHistory(copiedRoot));
  t.after(() => copied.close());
  const location = { host: "pi", directory: join(copiedRoot, "native-sessions") };
  await copied.refresh(location);
  assert.deepEqual(copiedFiles.list(), [record]);
  assert.deepEqual(copied.warnings, []);
  assert.equal(copied.search().total, 1);
  const found = copied.search({ query: needle }).matches[0];
  assert.equal(found.id, summary.id);
  const child = copied.read(found.id).children[0];
  assert.equal(copied.read(child.id).text, service.read(child.id).text);
  assert.ok(copied.read(child.id).parents.some(parent => parent.id === found.id));
  await mkdir(location.directory, { recursive: true });
  const relocated = join(location.directory, basename(file));
  await cp(file, relocated);
  await copied.refresh({ ...location, file: relocated });
  assert.equal(copied.search().total, 1);
  assert.equal(copied.read(summary.id).text, needle);
  assert.deepEqual(copied.read(summary.id).source, { host: "pi", sessionId: manager.getSessionId(), entryIds: summary.entryIds });
  assert.equal(copiedFiles.list().length, 1);
  assert.equal(await readFile(file, "utf8"), original);
});

for (const host of ["pi", "dsh"]) {
  test(`${host} migration preserves locked or conflicting archives and resumes without replacing the destination`, async t => {
    const { root, manager, file } = await fixture(t);
    exchange(manager, "已有问题", "已有答复");
    const record = indexHistory(projectHistory(await readFile(file, "utf8")), undefined, host), old = await legacyArchive(root, record);
    const oldContent = await readFile(old.path, "utf8"), files = new HistoryFiles(join(root, ".pbot/history"), host);
    record.nodes.find(node => node.kind === "exchange").text += "\n已更新的归档"; files.save(record);
    const target = join(files.directory, record.id + ".json"), current = await readFile(target, "utf8");
    const sibling = join(root, "." + host, "pbot/keep.txt"); await writeFile(sibling, "other workspace data");
    const lock = join(old.directory, ".write"); await mkdir(lock);
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), oldContent);
    assert.equal(await readFile(target, "utf8"), current);
    await rm(lock, { recursive: true });
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), oldContent);
    assert.equal(await readFile(target, "utf8"), current);
    // A reconciled duplicate still lacks host and can finish an interrupted copy.
    await legacyArchive(root, record);
    files.migrate(root);
    assert.equal(await readFile(target, "utf8"), current);
    await assert.rejects(stat(old.directory), { code: "ENOENT" });
    assert.equal(await readFile(sibling, "utf8"), "other workspace data");
  });

  test(`${host} migration preserves the old file when publication fails or a parent alias identifies the same file`, async t => {
    const { root, manager, file } = await fixture(t);
    exchange(manager, "已有问题", "已有答复");
    const record = indexHistory(projectHistory(await readFile(file, "utf8")), undefined, host), old = await legacyArchive(root, record);
    const original = await readFile(old.path, "utf8"), shared = join(root, ".pbot"), files = new HistoryFiles(join(shared, "history"), host);
    const blocked = join(files.directory, record.id + ".json"); await mkdir(blocked, { recursive: true });
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), original);
    await rm(shared, { recursive: true });
    await symlink(join(root, "." + host, "pbot"), shared);
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), original);
    await rm(shared);
    files.migrate(root);
    assert.deepEqual(JSON.parse(await readFile(blocked, "utf8")), record);
    await assert.rejects(stat(old.directory), { code: "ENOENT" });
  });
}

test("archive host is required and independent of ID prefixes; damaged files leave valid archives readable", async t => {
  const { root, manager, file } = await fixture(t);
  exchange(manager, "已有问题", "已有答复");
  const source = projectHistory(await readFile(file, "utf8"));
  const pi = { ...indexHistory(source, undefined, "dsh"), host: "pi" }, dsh = { ...indexHistory(source), host: "dsh" };
  const piFiles = new HistoryFiles(join(root, ".pbot/history")), dshFiles = new HistoryFiles(piFiles.directory, "dsh");
  piFiles.save(pi); dshFiles.save(dsh);
  assert.deepEqual(piFiles.list(), [pi]); assert.deepEqual(dshFiles.list(), [dsh]);
  assert.throws(() => piFiles.save(dsh)); assert.throws(() => dshFiles.save(pi));
  const service = new HistoryService(root, piFiles, new PiHistory(root), [dshFiles]); t.after(() => service.close());
  const location = { host: "pi", directory: join(root, "unavailable-native") };
  await service.refresh(location);
  assert.equal(service.read(pi.id).host, "pi"); assert.equal(service.read(dsh.id).host, "dsh");
  const path = join(piFiles.directory, pi.id + ".json"), original = await readFile(path, "utf8");
  for (const broken of [JSON.stringify({ ...pi, host: undefined }), JSON.stringify({ ...pi, host: "other" }), "invalid JSON"]) {
    await writeFile(path, broken); await service.refresh(location);
    assert.equal(service.search().total, 1);
    assert.equal(service.search().matches[0].host, "dsh");
    assert.equal(service.warnings.length, 1);
    assert.equal(await readFile(path, "utf8"), broken);
  }
  await writeFile(path, original); await service.refresh(location);
  assert.deepEqual(service.warnings, []); assert.equal(service.search().total, 2);
});

test("history searches all levels, pages original text and links, and reuses saved summaries after refresh", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 20; i++) exchange(manager, `中文问题 ${i}`, "长回答🙂".repeat(400));
  const original = await readFile(file, "utf8"), source = projectHistory(original);
  const files = new HistoryFiles(join(root, "index")), record = indexHistory(source);
  const saved = record.nodes.find(node => node.kind === "summary"), needle = randomUUID();
  saved.text = needle; saved.ready = true; files.save(record);
  const service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close());
  await service.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  const hit = service.search({ query: needle });
  assert.equal(hit.matches.length, 1);
  assert.equal(hit.matches[0].kind, "summary");
  const summary = service.read(hit.matches[0].id);
  assert.equal(summary.children.length, 4);
  assert.ok(summary.parents.length);
  const leaf = summary.children[0], whole = service.read(leaf.id), first = service.read(leaf.id, 0, 137);
  let text = first.text, next = first.nextOffset;
  while (next !== null) { const page = service.read(leaf.id, next, 137); text += page.text; next = page.nextOffset; }
  assert.equal(text, whole.text);
  const hits = service.search({ query: "中文问题", limit: 3 });
  assert.equal(hits.total, 20); assert.equal(hits.nextOffset, 3);
  assert.equal(service.search({ query: "中文问题", from: "2100-01-01" }).total, 0);
  assert.equal(service.search({ sessionId: manager.getSessionId() }).total, 1);
  exchange(manager, "新增问题", "新增回答");
  await service.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  assert.equal(service.read(saved.id).text, needle);
  assert.equal(service.search({ query: "新增问题" }).total, 1);
  assert.ok((await readFile(file, "utf8")).startsWith(original));
  await service.close();
  assert.throws(() => service.search());
  const reopened = new HistoryService(root, files, new PiHistory(root));
  t.after(() => reopened.close());
  await reopened.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  assert.equal(reopened.read(saved.id).text, needle);
});

test("three archive sources keep identical native session IDs separate after copying, without writing peer archives", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, "共享问题 " + i, "归档答复 " + i);
  const session = projectHistory(await readFile(file, "utf8")), directory = join(root, "archives");
  const readers = ["pi", "dsh", "claude"].map(host => new HistoryFiles(directory, host));
  const records = readers.map(files => {
    const record = indexHistory(session, undefined, files.host);
    const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "已存摘要 " + files.host; summary.ready = true;
    files.save(record); return record;
  });
  assert.ok(records[1].id.startsWith("dsh-")); assert.ok(records[2].id.startsWith("claude-"));
  const copiedRoot = join(root, "copy"), copied = join(copiedRoot, ".pbot/history");
  await cp(directory, copied, { recursive: true });
  const own = new HistoryFiles(copied), peers = [new HistoryFiles(copied, "dsh"), new HistoryFiles(copied, "claude")];
  // Read capabilities contain no write or migration method.
  const service = new HistoryService(copiedRoot, own, new PiHistory(copiedRoot), peers.map(files => ({
    host: files.host, list: () => files.list(), get warnings() { return files.warnings; },
  })));
  t.after(() => service.close());
  const location = { host: "pi", directory: join(copiedRoot, "missing-native") };
  const paths = records.map(record => join(copied, record.id + ".json")), bytes = await Promise.all(paths.map(path => readFile(path, "utf8")));
  await service.refresh(location);
  assert.equal(service.search({ sessionId: session.sessionId }).total, 3);
  const valid = schema(historyResultSchema);
  assert.equal(valid(service.search()), true);
  for (const record of records) {
    assert.equal(service.search(historyInput({ action: "search", host: record.host })).total, 1);
    const summary = record.nodes.find(node => node.kind === "summary"), node = service.read(summary.id, 0, 12000, 0, record.host);
    assert.deepEqual(node.source, { host: record.host, sessionId: session.sessionId, entryIds: summary.entryIds });
    assert.equal(node.text, summary.text);
    assert.equal(valid({ node, warnings: service.warnings }), true);
    assert.throws(() => readers.find(files => files.host !== record.host).save(record));
  }
  assert.throws(() => historyInput({ action: "search", host: "other" }));
  await writeFile(paths[2], "invalid JSON"); await service.refresh(location);
  assert.equal(service.search().total, 2); assert.equal(service.warnings.length, 1);
  await writeFile(paths[2], bytes[2]); await service.refresh(location);
  assert.equal(service.search().total, 3); assert.deepEqual(service.warnings, []);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), bytes);
  await assert.rejects(new PiHistory(root).scan({ host: "claude", sessionId: session.sessionId }));
});

test("Claude storage skips legacy directories and takes only its own source lock", async t => {
  const { root, manager, file } = await fixture(t);
  exchange(manager, "归档资料", "已有原文");
  const record = indexHistory(projectHistory(await readFile(file, "utf8")), undefined, "claude");
  const old = await legacyArchive(root, record), legacy = await readFile(old.path, "utf8");
  const files = new HistoryFiles(join(root, ".pbot/history"), "claude");
  files.migrate(root);
  assert.equal(await readFile(old.path, "utf8"), legacy);
  await assert.rejects(stat(files.directory), { code: "ENOENT" });
  files.save(record);
  const marker = join(files.directory, "independent");
  new HistoryFiles(files.directory, "pi").control(() => new HistoryFiles(files.directory, "dsh").control(() => files.control(() => {
    writeFileSync(marker, "claude writer");
    assert.throws(() => new HistoryFiles(files.directory, "claude").control(() => {}), { code: "PBOT_HISTORY_BUSY" });
  })));
  assert.equal(await readFile(marker, "utf8"), "claude writer");
  assert.deepEqual(files.list(), [record]); assert.equal(await readFile(old.path, "utf8"), legacy);
});

test("shortened scans retain branch archives and invalidate summaries through observed shared prefixes", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, "共同问题 " + i, "共同答复 " + i);
  const fork = manager.getLeafId();
  for (let i = 0; i < 12; i++) exchange(manager, "分支 A " + i, "答复 A " + i);
  manager.branch(fork);
  for (let i = 0; i < 12; i++) exchange(manager, "分支 B " + i, "答复 B " + i);
  const native = await readFile(file, "utf8"), session = projectHistory(native);
  const archive = indexHistory(session);
  for (const node of archive.nodes.filter(node => node.kind === "summary")) { node.text = "已存 " + node.id; node.ready = true; }
  const retained = indexHistory({ ...session, branches: [session.branches[0].slice(-2)] }, archive);
  assert.deepEqual(retained, archive);
  assert.deepEqual(indexHistory({ ...session, branches: [] }, archive), archive);
  const branch = structuredClone(session.branches[0].slice(0, 4));
  branch[0].text += "\n原文修订"; branch[0].completed = false; branch[0].from = "2020-01-01T00:00:00.000Z";
  const updated = indexHistory({ ...session, branches: [branch] }, retained), changed = new Set();
  for (const node of updated.nodes.filter(node => node.kind === "exchange")) {
    const before = archive.nodes.find(value => value.id === node.id);
    if (node.text !== before.text) changed.add(node.id);
  }
  assert.equal(changed.size, 1); assert.equal(updated.nodes.length, archive.nodes.length);
  for (const node of updated.nodes.filter(node => node.kind === "summary").sort((a, b) => a.level - b.level)) {
    if (node.children.some(id => changed.has(id))) {
      changed.add(node.id); assert.equal(node.ready, false); assert.equal(node.text, ""); assert.equal(node.completed, false);
    } else assert.deepEqual(node, archive.nodes.find(value => value.id === node.id));
  }
  assert.equal(updated.nodes.filter(node => node.level === 2 && !node.ready).length, 2);
  const files = new HistoryFiles(join(root, "retained")); files.save(updated);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  // A read-only native scan contains only the surviving suffix of one branch.
  const surviving = session.branches[0].slice(-4), ids = new Set(surviving.flatMap(exchange => exchange.entryIds));
  const lines = native.trim().split("\n").filter(line => { const entry = JSON.parse(line); return entry.type === "session" || ids.has(entry.id); });
  const directory = join(root, "shortened-native"); await mkdir(directory);
  const path = join(directory, basename(file)), shortened = lines.join("\n") + "\n"; await writeFile(path, shortened);
  await service.refresh({ host: "pi", directory, file: path });
  assert.equal(service.search({ query: "原文修订" }).total, 1);
  assert.equal(service.search({ query: "分支 A" }).total, 12); assert.equal(service.search({ query: "分支 B" }).total, 12);
  assert.equal(await readFile(path, "utf8"), shortened); assert.equal(await readFile(file, "utf8"), native);
});

test("an observed exchange updates all structured fields and invalidates its summary", async t => {
  const { manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, "问题 " + i, "答复 " + i);
  const session = projectHistory(await readFile(file, "utf8")), record = indexHistory(session);
  const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "旧摘要"; summary.ready = true;
  for (const change of [value => { value.entryIds[0] += "-corrected"; }, value => { value.from = "2020-01-01T00:00:00.000Z"; },
    value => { value.to = "2100-01-01T00:00:00.000Z"; }, value => { value.completed = false; }]) {
    const observed = structuredClone(session); change(observed.branches[0][0]);
    const updated = indexHistory(observed, record), node = updated.nodes.find(node => node.kind === "summary");
    assert.equal(node.ready, false); assert.equal(node.text, "");
    const exchange = updated.nodes.find(value => value.id === node.children[0]);
    assert.deepEqual(exchange.entryIds, observed.branches[0][0].entryIds);
    assert.equal(exchange.from, observed.branches[0][0].from); assert.equal(exchange.to, observed.branches[0][0].to);
    assert.equal(exchange.completed, observed.branches[0][0].completed);
  }
});

for (const partial of [false, true]) test(`a later native answer replaces its observed ${partial ? "tool-phase" : "unanswered"} exchange without retaining a stale summary`, async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 3; i++) exchange(manager, "完成问题 " + i, "完成答复 " + i);
  const user = manager.appendMessage({ role: "user", content: "等待答复的问题", timestamp: Date.now() });
  const interim = partial ? assistant(manager, [{ type: "text", text: "执行工具前的文本" },
    { type: "toolCall", id: "pending", name: "bash", arguments: { command: "pwd" } }], "toolUse") : user;
  const files = new HistoryFiles(join(root, "index")), service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close());
  const location = { host: "pi", directory: manager.getSessionDir(), file };
  await service.refresh(location);
  const before = files.list()[0], oldSummary = before.nodes.find(node => node.kind === "summary");
  oldSummary.text = "旧的部分摘要"; oldSummary.ready = true; files.save(before);
  assert.ok(before.nodes.some(node => node.kind === "exchange" && node.entryIds.at(-1) === interim));
  const answer = assistant(manager, [{ type: "text", text: "落盘后的最终答复" }]);
  const native = await readFile(file, "utf8"); await service.refresh(location);
  const updated = files.list()[0], exchanges = updated.nodes.filter(node => node.kind === "exchange");
  assert.equal(exchanges.length, 4); assert.equal(updated.nodes.some(node => node.id === oldSummary.id), false);
  const completed = exchanges.find(node => node.entryIds[0] === user);
  assert.deepEqual(completed.entryIds, [user, answer]); assert.equal(completed.completed, true);
  const summary = updated.nodes.find(node => node.kind === "summary"); assert.equal(summary.ready, false); assert.equal(summary.text, "");
  assert.equal(service.search({ query: "旧的部分摘要" }).total, 0); assert.equal(service.status.pending, 1);
  assert.equal(await readFile(file, "utf8"), native);
});

test("a native suffix inside an exchange retains its archived prefix and saved summary", async t => {
  const { manager, file } = await fixture(t);
  manager.appendMessage({ role: "user", content: "保留的第一条要求", timestamp: Date.now() });
  const second = manager.appendMessage({ role: "user", content: "后续要求", timestamp: Date.now() });
  assistant(manager, [{ type: "text", text: "完整答复" }]);
  for (let i = 0; i < 3; i++) exchange(manager, "其他问题 " + i, "其他答复 " + i);
  const native = await readFile(file, "utf8"), archive = indexHistory(projectHistory(native));
  const summary = archive.nodes.find(node => node.kind === "summary"); summary.text = "已有完整摘要"; summary.ready = true;
  const lines = native.trim().split("\n"), start = lines.findIndex(line => JSON.parse(line).id === second);
  const shortened = [lines[0], ...lines.slice(start)].join("\n") + "\n";
  assert.deepEqual(indexHistory(projectHistory(shortened), archive), archive);
});

test("an incomplete native fork remains archived when another branch finishes the same question", async t => {
  const { manager, file } = await fixture(t);
  const user = manager.appendMessage({ role: "user", content: "分叉的问题", timestamp: Date.now() });
  const partial = assistant(manager, [{ type: "text", text: "独立分支的部分答复" }], "aborted");
  const archived = indexHistory(projectHistory(await readFile(file, "utf8")));
  manager.branch(user);
  assistant(manager, [{ type: "text", text: "另一分支的最终答复" }]);
  const updated = indexHistory(projectHistory(await readFile(file, "utf8")), archived);
  assert.equal(updated.nodes.filter(node => node.kind === "exchange").length, 2);
  assert.ok(updated.nodes.some(node => node.kind === "exchange" && node.entryIds.at(-1) === partial && !node.completed));
});

test("summary splitting preserves Unicode and text across bounded segments", () => {
  const text = "开头🙂资料".repeat(400) + "结尾", parts = splitHistorySummary(text, 13);
  assert.equal(parts.join(""), text); assert.ok(parts.every(part => part.length <= 13 && !/[\uD800-\uDBFF]$/.test(part)));
  for (const budget of [0, 1, -1, 2.5, NaN]) assert.throws(() => splitHistorySummary(text, budget));
});
