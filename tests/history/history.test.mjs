import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HistoryService } from "../../dist/services/history/history-service.js";
import { historySummaries, historyView, indexHistory, retainHistorySummaries } from "../../dist/services/history/history-index.js";
import { assertArchiveReadable, legacyArchive, writeMixedArchive } from "../helpers/history-archive.mjs";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { PiHistory, projectHistory } from "../../dist/integrations/pi/history.js";
import { splitHistorySummary } from "../../dist/integrations/history-summary.js";
import { historyInput, historyResultSchema } from "../../dist/tools/history/contract.js";
import { schema } from "../../dist/common/schema.js";

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
  const raw = indexHistory(source), record = historyView(raw), leaves = raw.exchanges;
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
  const original = await readFile(file, "utf8"), raw = indexHistory(projectHistory(original));
  const record = { ...historyView(raw), file };
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
  assertArchiveReadable(service, record);
  const [archive] = files.list();
  const rawBytes = await readFile(join(files.directory, "raw", record.id + ".json"), "utf8");
  assert.deepEqual(JSON.parse(rawBytes), { ...raw, name: record.name, branches: [] });
  const { kind, parents, ...savedSummary } = summary;
  const derived = JSON.parse(await readFile(join(files.directory, "summary", record.id + ".json"), "utf8"));
  assert.deepEqual(derived, { host: "pi", id: record.id, sessionId: record.sessionId, summaries: [savedSummary] });
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
  assert.deepEqual(copiedFiles.list(), [archive]);
  assertArchiveReadable(copied, record);
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

test("an interrupted split resumes from its published summaries without overwriting a conflict", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, `旧问题 ${i}`, `旧答复 ${i}`);
  const raw = indexHistory(projectHistory(await readFile(file, "utf8"))), mixed = historyView(raw);
  const summary = mixed.nodes.find(node => node.kind === "summary"); summary.text = "旧档摘要"; summary.ready = true;
  const files = new HistoryFiles(join(root, ".pbot/history")), path = await writeMixedArchive(files.directory, mixed);
  const bytes = await readFile(path), directory = join(files.directory, "summary"); await mkdir(directory);
  const derived = join(directory, raw.id + ".json"), document = { host: raw.host, id: raw.id, sessionId: raw.sessionId, summaries: historySummaries(mixed) };
  const published = JSON.stringify(document); document.summaries[0].text = "另一份摘要";
  const conflict = JSON.stringify(document); await writeFile(derived, conflict);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  const offline = { host: "pi", directory: join(root, "offline") };
  await service.refresh(offline);
  assert.ok(service.warnings.length); assert.deepEqual(await readFile(path), bytes);
  assert.equal(await readFile(derived, "utf8"), conflict); assert.equal(service.read(summary.id).text, summary.text);
  // A published summary alone is not a raw archive. Refresh completes the move and retires the old file.
  await writeFile(derived, published); await service.refresh(offline);
  assert.deepEqual(service.warnings, []); assertArchiveReadable(service, mixed);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(join(files.directory, "raw", raw.id + ".json"), "utf8")), { ...raw, name: mixed.name, branches: [] });
  assert.equal(await readFile(derived, "utf8"), published);
});

test("an existing raw file and its hierarchical summary move together without changing their contents", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, `问 ${i}`, `答 ${i}`);
  const raw = indexHistory(projectHistory(await readFile(file, "utf8"))), record = historyView(raw);
  const node = record.nodes.find(item => item.kind === "summary"); node.text = "已保存的摘要"; node.ready = true;
  const files = new HistoryFiles(join(root, ".pbot/history")), name = raw.id + ".json";
  const oldDir = join(files.directory, "hierarchical"), memory = join(files.directory, "memory", name);
  await mkdir(oldDir, { recursive: true }); await mkdir(join(files.directory, "memory"));
  const bytes = JSON.stringify(raw), derived = JSON.stringify({ host: raw.host, id: raw.id, sessionId: raw.sessionId, summaries: historySummaries(record) });
  await writeFile(join(files.directory, name), bytes); await writeFile(join(oldDir, name), derived);
  await writeFile(memory, "unrelated data");
  new HistoryFiles(files.directory, "dsh").migrate(root);
  assert.deepEqual(files.list(root), [{ raw, summaries: historySummaries(record) }]);
  await assert.rejects(stat(join(files.directory, "raw")), { code: "ENOENT" });
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  await service.refresh({ host: "pi", directory: join(root, "offline") });
  assert.deepEqual(service.warnings, []); assertArchiveReadable(service, record);
  assert.equal(await readFile(join(files.directory, "raw", name), "utf8"), bytes);
  assert.equal(await readFile(join(files.directory, "summary", name), "utf8"), derived);
  await assert.rejects(stat(join(files.directory, name)), { code: "ENOENT" });
  await assert.rejects(stat(oldDir), { code: "ENOENT" });
  assert.equal(await readFile(memory, "utf8"), "unrelated data");
});

test("a mixed archive retains three ungrouped fork tails until their native paths return", async t => {
  const { root, manager, file } = await fixture(t);
  manager.appendSessionInfo("分叉归档");
  for (let i = 1; i <= 4; i++) exchange(manager, `共同问题 ${i}`, `共同答复 ${i}`);
  const fork = manager.getLeafId(), tips = [];
  for (const name of ["A", "B", "C"]) {
    manager.branch(fork);
    for (let i = 1; i <= 3; i++) exchange(manager, `分支问题 ${name} ${i}`, `分支答复 ${name} ${i}`);
    tips.push(manager.getLeafId());
  }
  const original = await readFile(file, "utf8"), raw = indexHistory(projectHistory(original));
  const record = historyView(raw), saved = record.nodes.find(node => node.kind === "summary");
  saved.text = "旧档中的共同摘要"; saved.ready = true;
  const files = new HistoryFiles(join(root, ".pbot/history"));
  await writeMixedArchive(files.directory, record);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  const directory = join(root, "recovered-native"), location = { host: "pi", directory };
  await service.refresh(location);
  assert.deepEqual(service.warnings, []);
  assertArchiveReadable(service, record);
  assert.equal(service.search({ query: "分支问题" }).total, 9);
  assert.equal(service.status.pending, 0);
  const tailIds = new Set(raw.exchanges.filter(leaf => !saved.children.includes(leaf.id)).map(leaf => leaf.id));
  const [offline] = files.list();
  assert.ok(offline.raw.branches.every(path => path.length <= 1 || path.every(id => !tailIds.has(id))));

  manager.branch(tips[0]);
  exchange(manager, "分支问题 A 4", "分支答复 A 4");
  const full = await readFile(file, "utf8"), branch = new Set(manager.getBranch(manager.getLeafId()).map(entry => entry.id));
  const ends = new Set(projectHistory(full).branches.flat().map(leaf => leaf.entryIds.at(-1)));
  const partial = full.trimEnd().split("\n").filter(line => {
    const entry = JSON.parse(line); return entry.type === "session" || branch.has(entry.id);
  }).join("\n") + "\n";
  await mkdir(directory);
  const recovered = join(directory, basename(file));
  for (const native of [partial, full]) {
    await writeFile(recovered, native); await service.refresh({ ...location, file: recovered });
    assert.deepEqual(service.warnings, []);
    assert.equal(service.search().total, 1);
    assert.equal(service.search({ query: "分支问题" }).total, 10);
    assert.equal(service.read(saved.id).text, saved.text);
    assert.equal(service.status.pending, 1);
    const [{ raw: restored, summaries }] = files.list();
    assert.equal(restored.id, record.id);
    assert.equal(restored.exchanges.length, 14);
    assert.deepEqual(new Set(restored.exchanges.map(leaf => leaf.entryIds.at(-1))), ends);
    const nativePaths = projectHistory(native).branches.map(path => path.map(leaf => leaf.entryIds.at(-1)));
    const entryIds = new Map(restored.exchanges.map(leaf => [leaf.id, leaf.entryIds.at(-1)]));
    const restoredPaths = restored.branches.filter(path => path.length > 1).map(path => path.map(id => entryIds.get(id)));
    assert.deepEqual(restoredPaths.toSorted(), nativePaths.toSorted());
    const planned = historyView(restored, summaries).nodes.filter(node => node.kind === "summary");
    assert.equal(planned.length, 2);
    const group = service.read(planned.find(node => !node.ready).id);
    assert.deepEqual(group.children.map(child => service.read(child.id).source.entryIds.at(-1)),
      nativePaths.find(path => path.length === 8).slice(-4));
  }
  const restored = files.list();
  await service.refresh({ ...location, file: recovered });
  assert.deepEqual(files.list(), restored);
  assert.equal(await readFile(file, "utf8"), full);
  assert.equal(await readFile(recovered, "utf8"), full);
});

for (const host of ["pi", "dsh"]) {
  test(`${host} migration preserves locked or conflicting archives and resumes without replacing the destination`, async t => {
    const { root, manager, file } = await fixture(t);
    for (let i = 0; i < 4; i++) exchange(manager, `已有问题 ${i}`, `已有答复 ${i}`);
    const record = historyView(indexHistory(projectHistory(await readFile(file, "utf8")), undefined, host));
    const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "旧摘要"; summary.ready = true;
    const old = await legacyArchive(root, record), oldContent = await readFile(old.path, "utf8");
    const files = new HistoryFiles(join(root, ".pbot/history"), host), [current] = files.list(root);
    current.raw.exchanges[0].text += "\n已更新的归档";
    current.summaries.find(node => node.id === summary.id).text = "已更新的摘要";
    files.saveRaw(current.raw); files.saveSummaries(current.raw, current.summaries);
    const targets = [join(files.directory, "raw", record.id + ".json"), join(files.directory, "summary", record.id + ".json")];
    const targetBytes = () => Promise.all(targets.map(path => readFile(path, "utf8"))), published = await targetBytes();
    const sibling = join(root, "." + host, "pbot/keep.txt"); await writeFile(sibling, "other workspace data");
    const lock = join(old.directory, ".write"); await mkdir(lock);
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), oldContent);
    assert.deepEqual(await targetBytes(), published);
    await rm(lock, { recursive: true });
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), oldContent);
    assert.deepEqual(await targetBytes(), published);

    const leaf = current.raw.exchanges[0]; record.nodes.find(node => node.id === leaf.id).text = leaf.text;
    await legacyArchive(root, record);
    const summaryConflict = await readFile(old.path, "utf8");
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), summaryConflict);
    assert.deepEqual(await targetBytes(), published);
    summary.text = "已更新的摘要"; await legacyArchive(root, record);
    files.migrate(root);
    assert.deepEqual(await targetBytes(), published);
    await assert.rejects(stat(old.directory), { code: "ENOENT" });
    assert.equal(await readFile(sibling, "utf8"), "other workspace data");
  });

  test(`${host} migration preserves the old file when publication fails or a parent alias identifies the same file`, async t => {
    const { root, manager, file } = await fixture(t);
    for (let i = 0; i < 4; i++) exchange(manager, `已有问题 ${i}`, `已有答复 ${i}`);
    const record = historyView(indexHistory(projectHistory(await readFile(file, "utf8")), undefined, host));
    const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "需一并复制的摘要"; summary.ready = true;
    const old = await legacyArchive(root, record), original = await readFile(old.path, "utf8");
    const shared = join(root, ".pbot"), files = new HistoryFiles(join(shared, "history"), host);
    const [expected] = files.list(root);
    const blocked = join(files.directory, "raw", record.id + ".json"); await mkdir(blocked, { recursive: true });
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), original);
    await rm(shared, { recursive: true });
    await symlink(join(root, "." + host, "pbot"), shared);
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), original);
    await rm(shared);
    const derived = join(files.directory, "summary", record.id + ".json");
    await mkdir(derived, { recursive: true });
    assert.throws(() => files.migrate(root));
    assert.equal(await readFile(old.path, "utf8"), original);
    await rm(derived, { recursive: true });
    files.migrate(root);
    assert.deepEqual(JSON.parse(await readFile(blocked, "utf8")), expected.raw);
    assert.deepEqual(files.list(), [expected]);
    assert.equal(expected.summaries.find(node => node.id === summary.id).text, summary.text);
    await assert.rejects(stat(old.directory), { code: "ENOENT" });
  });
}

test("archive host is required and independent of ID prefixes; damaged files leave valid archives readable", async t => {
  const { root, manager, file } = await fixture(t);
  exchange(manager, "已有问题", "已有答复");
  const source = projectHistory(await readFile(file, "utf8"));
  const pi = { ...indexHistory(source, undefined, "dsh"), host: "pi" }, dsh = { ...indexHistory(source), host: "dsh" };
  const piFiles = new HistoryFiles(join(root, ".pbot/history")), dshFiles = new HistoryFiles(piFiles.directory, "dsh");
  piFiles.saveRaw(pi); dshFiles.saveRaw(dsh);
  assert.deepEqual(piFiles.list(), [{ raw: pi, summaries: [] }]); assert.deepEqual(dshFiles.list(), [{ raw: dsh, summaries: [] }]);
  assert.throws(() => piFiles.saveRaw(dsh)); assert.throws(() => dshFiles.saveRaw(pi));
  assert.throws(() => piFiles.saveSummaries(dsh, [])); assert.throws(() => dshFiles.saveSummaries(pi, []));
  const service = new HistoryService(root, piFiles, new PiHistory(root), [dshFiles]); t.after(() => service.close());
  const location = { host: "pi", directory: join(root, "unavailable-native") };
  await service.refresh(location);
  assert.equal(service.read(pi.id).host, "pi"); assert.equal(service.read(dsh.id).host, "dsh");
  const path = join(piFiles.directory, "raw", pi.id + ".json"), original = await readFile(path, "utf8");
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

test("the raw archive rejects derived fields and builds an unnamed session preview only for reading", async t => {
  const { root, manager, file } = await fixture(t);
  exchange(manager, "未命名会话的原始问题", "原始答复");
  const files = new HistoryFiles(join(root, ".pbot/history")), service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close()); await service.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  const [{ raw }] = files.list(), path = join(files.directory, "raw", raw.id + ".json"), bytes = await readFile(path);
  assert.equal(raw.name, ""); assert.ok(service.read(raw.id).name.includes("未命名会话的原始问题"));
  for (const value of [{ ...raw, memory: [] }, { ...raw, summaries: [] }, historyView(raw),
    { ...raw, exchanges: raw.exchanges.map(item => ({ ...item, summary: "派生文本" })) }]) {
    assert.throws(() => files.saveRaw(value));
    assert.deepEqual(await readFile(path), bytes);
  }
  await assert.rejects(stat(join(files.directory, "summary")), { code: "ENOENT" });
  await assert.rejects(stat(join(files.directory, "memory")), { code: "ENOENT" });
});

test("a missing or unreadable summary file leaves the original exchanges searchable offline", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, `原始提问 ${i}`, `独立保存的答复 ${i}`);
  const files = new HistoryFiles(join(root, ".pbot/history")), service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close());
  await service.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  const [{ raw }] = files.list(), view = historyView(raw), summary = view.nodes.find(node => node.kind === "summary");
  summary.text = "已有分层摘要"; summary.ready = true; files.saveSummaries(raw, historySummaries(view));
  const offline = { host: "pi", directory: join(root, "missing-native") };
  await service.refresh(offline);
  assert.equal(service.read(summary.id).text, summary.text);
  const path = join(files.directory, "raw", raw.id + ".json"), rawBytes = await readFile(path);
  const derived = join(files.directory, "summary", raw.id + ".json");
  const foreign = { ...JSON.parse(await readFile(derived, "utf8")), sessionId: randomUUID() };
  for (const contents of ["invalid JSON", JSON.stringify(foreign), null]) {
    if (contents === null) await rm(derived);
    else await writeFile(derived, contents);
    await service.refresh(offline);
    const [archive] = files.list();
    assert.deepEqual(archive.summaries, contents === null ? [] : null);
    assert.equal(service.warnings.length, contents === null ? 0 : 1);
    assert.equal(service.search({ query: summary.text }).total, 0);
    const hits = service.search({ query: "独立保存的答复" });
    assert.equal(hits.total, 4);
    for (const leaf of raw.exchanges) {
      assert.ok(hits.matches.some(hit => hit.id === leaf.id));
      const node = service.read(leaf.id);
      assert.equal(node.text, leaf.text);
      assert.deepEqual(node.source, { host: "pi", sessionId: manager.getSessionId(), entryIds: leaf.entryIds });
    }
    assert.deepEqual(await readFile(path), rawBytes);
  }
});

test("history searches all levels, pages original text and links, and reuses saved summaries after refresh", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 20; i++) exchange(manager, `中文问题 ${i}`, "长回答🙂".repeat(400));
  const original = await readFile(file, "utf8"), source = projectHistory(original);
  const files = new HistoryFiles(join(root, "index")), raw = indexHistory(source), record = historyView(raw);
  const saved = record.nodes.find(node => node.kind === "summary"), needle = randomUUID();
  saved.text = needle; saved.ready = true; files.saveRaw(raw); files.saveSummaries(raw, historySummaries(record));
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
  const records = [];
  for (const files of readers) {
    const raw = indexHistory(session, undefined, files.host), record = historyView(raw);
    const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "已存摘要 " + files.host; summary.ready = true;
    if (files.host === "pi") { files.saveRaw(raw); files.saveSummaries(raw, historySummaries(record)); }
    else await writeMixedArchive(directory, record);
    records.push(record);
  }
  assert.ok(records[1].id.startsWith("dsh-")); assert.ok(records[2].id.startsWith("claude-"));
  const copiedRoot = join(root, "copy"), copied = join(copiedRoot, ".pbot/history");
  await cp(directory, copied, { recursive: true });
  const own = new HistoryFiles(copied), peers = [new HistoryFiles(copied, "dsh"), new HistoryFiles(copied, "claude")];
  const service = new HistoryService(copiedRoot, own, new PiHistory(copiedRoot), peers);
  t.after(() => service.close());
  const location = { host: "pi", directory: join(copiedRoot, "missing-native") };
  const paths = records.map(record => join(copied, record.host === "pi" ? "raw" : "", record.id + ".json"));
  const layer = join(copied, "summary", records[0].id + ".json");
  const contents = () => Promise.all([...paths, layer].map(path => readFile(path))), bytes = await contents();
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
    assertArchiveReadable(service, record);
    const [{ raw, summaries }] = readers.find(files => files.host === record.host).list();
    const foreign = readers.find(files => files.host !== record.host);
    assert.throws(() => foreign.saveRaw(raw)); assert.throws(() => foreign.saveSummaries(raw, summaries));
  }
  assert.throws(() => historyInput({ action: "search", host: "other" }));
  await writeFile(paths[2], "invalid JSON"); await service.refresh(location);
  assert.equal(service.search().total, 2); assert.equal(service.warnings.length, 1);
  await writeFile(paths[2], bytes[2]); await service.refresh(location);
  assert.equal(service.search().total, 3); assert.deepEqual(service.warnings, []);
  assert.deepEqual(await contents(), bytes);
  for (const peer of records.slice(1)) await assert.rejects(stat(join(copied, "summary", peer.id + ".json")), { code: "ENOENT" });
  await assert.rejects(new PiHistory(root).scan({ host: "claude", sessionId: session.sessionId }));
});

test("Pi reads a Claude mixed archive with its old control lock present and leaves both Claude locations intact", async t => {
  const { root, manager, file } = await fixture(t);
  exchange(manager, "归档资料", "已有原文");
  const record = historyView(indexHistory(projectHistory(await readFile(file, "utf8")), undefined, "claude"));
  const old = await legacyArchive(root, record), legacy = await readFile(old.path);
  const files = new HistoryFiles(join(root, ".pbot/history"), "claude");
  files.migrate(root);
  assert.deepEqual(await readFile(old.path), legacy);
  await assert.rejects(stat(files.directory), { code: "ENOENT" });
  const path = await writeMixedArchive(files.directory, record), bytes = await readFile(path);
  const lock = join(files.directory, ".write-claude"); await mkdir(lock);
  const marker = join(lock, "owner"); await writeFile(marker, "existing Claude control");
  const pi = new HistoryFiles(files.directory), dsh = new HistoryFiles(files.directory, "dsh");
  const [existing] = pi.control(() => dsh.control(() => files.list(root)));
  assert.throws(() => files.saveRaw(existing.raw)); assert.throws(() => files.saveSummaries(existing.raw, []));
  const collision = { ...existing.raw, host: "pi" };
  assert.throws(() => pi.saveRaw(collision)); assert.throws(() => pi.saveSummaries(collision, []));
  const service = new HistoryService(root, pi, new PiHistory(root), [dsh, files]); t.after(() => service.close());
  await service.refresh({ host: "pi", directory: manager.getSessionDir(), file });
  assert.deepEqual(service.warnings, []); assertArchiveReadable(service, record);
  assert.deepEqual(await readFile(path), bytes); assert.deepEqual(await readFile(old.path), legacy);
  assert.equal(await readFile(marker, "utf8"), "existing Claude control");
  await assert.rejects(stat(join(files.directory, "summary", record.id + ".json")), { code: "ENOENT" });
});

test("shortened scans retain branch archives and invalidate summaries through observed shared prefixes", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, "共同问题 " + i, "共同答复 " + i);
  const fork = manager.getLeafId();
  for (let i = 0; i < 12; i++) exchange(manager, "分支 A " + i, "答复 A " + i);
  manager.branch(fork);
  for (let i = 0; i < 12; i++) exchange(manager, "分支 B " + i, "答复 B " + i);
  const native = await readFile(file, "utf8"), session = projectHistory(native);
  const raw = indexHistory(session), archive = historyView(raw);
  for (const node of archive.nodes.filter(node => node.kind === "summary")) { node.text = "已存 " + node.id; node.ready = true; }
  const summaries = historySummaries(archive);
  const retained = indexHistory({ ...session, branches: [session.branches[0].slice(-2)] }, raw);
  assert.deepEqual(retained, raw);
  assert.deepEqual(indexHistory({ ...session, branches: [] }, raw), raw);
  assert.deepEqual(historyView(retained, retainHistorySummaries(raw, retained, summaries)), archive);
  const branch = structuredClone(session.branches[0].slice(0, 4));
  branch[0].text += "\n原文修订"; branch[0].completed = false; branch[0].from = "2020-01-01T00:00:00.000Z";
  const updatedRaw = indexHistory({ ...session, branches: [branch] }, retained);
  const updated = historyView(updatedRaw, retainHistorySummaries(retained, updatedRaw, summaries)), changed = new Set();
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
  const files = new HistoryFiles(join(root, "retained")); files.saveRaw(updatedRaw); files.saveSummaries(updatedRaw, historySummaries(updated));
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
  const session = projectHistory(await readFile(file, "utf8")), raw = indexHistory(session), record = historyView(raw);
  const summary = record.nodes.find(node => node.kind === "summary"); summary.text = "旧摘要"; summary.ready = true;
  const summaries = historySummaries(record);
  for (const change of [value => { value.entryIds[0] += "-corrected"; }, value => { value.from = "2020-01-01T00:00:00.000Z"; },
    value => { value.to = "2100-01-01T00:00:00.000Z"; }, value => { value.completed = false; }]) {
    const observed = structuredClone(session); change(observed.branches[0][0]);
    const updatedRaw = indexHistory(observed, raw), updated = historyView(updatedRaw, retainHistorySummaries(raw, updatedRaw, summaries));
    const node = updated.nodes.find(node => node.kind === "summary");
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
  const [before] = files.list(), view = historyView(before.raw, before.summaries);
  const oldSummary = view.nodes.find(node => node.kind === "summary");
  oldSummary.text = "旧的部分摘要"; oldSummary.ready = true; files.saveSummaries(before.raw, historySummaries(view));
  assert.ok(before.raw.exchanges.some(node => node.entryIds.at(-1) === interim));
  const answer = assistant(manager, [{ type: "text", text: "落盘后的最终答复" }]);
  const native = await readFile(file, "utf8"); await service.refresh(location);
  const [{ raw, summaries }] = files.list(), updated = historyView(raw, summaries), exchanges = raw.exchanges;
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
  const native = await readFile(file, "utf8"), raw = indexHistory(projectHistory(native)), archive = historyView(raw);
  const summary = archive.nodes.find(node => node.kind === "summary"); summary.text = "已有完整摘要"; summary.ready = true;
  const lines = native.trim().split("\n"), start = lines.findIndex(line => JSON.parse(line).id === second);
  const shortened = [lines[0], ...lines.slice(start)].join("\n") + "\n", updated = indexHistory(projectHistory(shortened), raw);
  assert.deepEqual(updated, raw);
  assert.deepEqual(historyView(updated, retainHistorySummaries(raw, updated, historySummaries(archive))), archive);
});

test("an incomplete native fork remains archived when another branch finishes the same question", async t => {
  const { manager, file } = await fixture(t);
  const user = manager.appendMessage({ role: "user", content: "分叉的问题", timestamp: Date.now() });
  const partial = assistant(manager, [{ type: "text", text: "独立分支的部分答复" }], "aborted");
  const archived = indexHistory(projectHistory(await readFile(file, "utf8")));
  manager.branch(user);
  assistant(manager, [{ type: "text", text: "另一分支的最终答复" }]);
  const updated = indexHistory(projectHistory(await readFile(file, "utf8")), archived);
  assert.equal(updated.exchanges.length, 2);
  assert.ok(updated.exchanges.some(node => node.entryIds.at(-1) === partial && !node.completed));
});

test("summary splitting preserves Unicode and text across bounded segments", () => {
  const text = "开头🙂资料".repeat(400) + "结尾", parts = splitHistorySummary(text, 13);
  assert.equal(parts.join(""), text); assert.ok(parts.every(part => part.length <= 13 && !/[\uD800-\uDBFF]$/.test(part)));
  for (const budget of [0, 1, -1, 2.5, NaN]) assert.throws(() => splitHistorySummary(text, budget));
});
