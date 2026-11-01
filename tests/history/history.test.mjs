import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { indexHistory, HistoryService } from "../../dist/services/history/history-service.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { PiHistory, projectHistory } from "../../dist/integrations/pi/history.js";

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
  const { root, manager, file } = await fixture(t);
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
  const original = await readFile(file, "utf8"), source = projectHistory(file, original);
  assert.equal(source.branches.length, 2);
  const record = indexHistory(root, source), leaves = record.nodes.filter(node => node.kind === "exchange");
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
  const service = new HistoryService(root, new HistoryFiles(join(root, ".pi/pbot/history")), new PiHistory(root));
  t.after(() => service.close());
  const location = { directory: manager.getSessionDir(), file };
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

test("workspace archives retain summaries across old-store import, copying, missing originals and native file relocation", async t => {
  const { root, manager, file } = await fixture(t), foreign = await fixture(t);
  for (let i = 0; i < 4; i++) exchange(manager, `迁移问题 ${i}`, `回答 ${i}`);
  exchange(foreign.manager, "其他工作区", "不应导入");
  const original = await readFile(file, "utf8"), previousFiles = new HistoryFiles(join(root, "user-history"));
  const record = { ...indexHistory(root, projectHistory(file, original)), workspace: root, file };
  const summary = record.nodes.find(node => node.kind === "summary"), needle = randomUUID();
  summary.text = needle; summary.ready = true; previousFiles.save(record);
  previousFiles.save({ ...indexHistory(foreign.root, projectHistory(foreign.file, await readFile(foreign.file, "utf8"))),
    workspace: foreign.root, file: foreign.file });
  const oldPath = join(previousFiles.directory, record.id + ".json"), oldContent = await readFile(oldPath, "utf8");
  const files = new HistoryFiles(join(root, ".pi/pbot/history"));
  const service = new HistoryService(root, files, new PiHistory(root), previousFiles);
  t.after(() => service.close());
  await service.refresh({ directory: manager.getSessionDir(), file });
  assert.equal(service.search().total, 1);
  assert.equal(service.read(summary.id).text, needle);
  assert.equal(files.list()[0].file, relative(root, file));
  assert.equal(Object.hasOwn(files.list()[0], "workspace"), false);
  assert.equal(await readFile(oldPath, "utf8"), oldContent);
  // Loading again must prefer the newer workspace archive over the old user-level copy.
  const current = files.list()[0];
  current.nodes.find(node => node.id === summary.id).text += " updated"; files.save(current);
  const reopened = new HistoryService(root, files, new PiHistory(root), previousFiles);
  t.after(() => reopened.close());
  await reopened.refresh({ directory: manager.getSessionDir(), file });
  assert.equal(reopened.read(summary.id).text, needle + " updated");

  const copiedRoot = join(root, "another-machine"), copiedFiles = new HistoryFiles(join(copiedRoot, ".pi/pbot/history"));
  await cp(files.directory, copiedFiles.directory, { recursive: true });
  const copied = new HistoryService(copiedRoot, copiedFiles, new PiHistory(copiedRoot));
  t.after(() => copied.close());
  const location = { directory: join(copiedRoot, "native-sessions") };
  await copied.refresh(location);
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
  assert.equal(copied.read(summary.id).text, needle + " updated");
  assert.equal(copied.read(summary.id).source.file, relative(copiedRoot, relocated));
  assert.equal(copiedFiles.list().length, 1);
  assert.equal(await readFile(file, "utf8"), original);
});

test("history searches all levels, pages original text and links, and reuses saved summaries after refresh", async t => {
  const { root, manager, file } = await fixture(t);
  for (let i = 0; i < 20; i++) exchange(manager, `中文问题 ${i}`, "长回答🙂".repeat(400));
  const original = await readFile(file, "utf8"), source = projectHistory(file, original);
  const files = new HistoryFiles(join(root, "index")), record = indexHistory(root, source);
  const saved = record.nodes.find(node => node.kind === "summary"), needle = randomUUID();
  saved.text = needle; saved.ready = true; files.save(record);
  const service = new HistoryService(root, files, new PiHistory(root));
  t.after(() => service.close());
  await service.refresh({ directory: manager.getSessionDir(), file });
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
  await service.refresh({ directory: manager.getSessionDir(), file });
  assert.equal(service.read(saved.id).text, needle);
  assert.equal(service.search({ query: "新增问题" }).total, 1);
  assert.ok((await readFile(file, "utf8")).startsWith(original));
  await service.close();
  assert.throws(() => service.search());
  const reopened = new HistoryService(root, files, new PiHistory(root));
  t.after(() => reopened.close());
  await reopened.refresh({ directory: manager.getSessionDir(), file });
  assert.equal(reopened.read(saved.id).text, needle);
});
