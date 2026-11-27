import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryService } from "../../dist/services/history/history-service.js";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";
import { historySummaries, historyView, indexHistory, retainHistorySummaries } from "../../dist/services/history/history-index.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { splitHistorySummary } from "../../dist/integrations/history-summary.js";
import { historyInput, historyResultSchema } from "../../dist/tools/history/contract.js";
import { schema } from "../../dist/common/schema.js";

function sessionFixture(sessionId, count, prefix = "问题") {
  const exchanges = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.UTC(2026, 10, 27, 10, i, 0)).toISOString();
    exchanges.push({
      entryIds: [`${sessionId}:${i}`],
      text: `用户：\n${prefix} ${i}\n\n助手：\n答复 ${i}`,
      from: t,
      to: t,
      completed: true,
    });
  }
  return { sessionId, name: "", branches: [exchanges] };
}

test("recordHistoryCapture writes raw archives incrementally per host and isolates foreign raw writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "pi-1", text: "第一问" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "pi-1", assistantText: "第一答", completed: true });
  recordHistoryCapture(root, "dsh", { kind: "input", sessionId: "dsh-1", text: "dsh 问题" });
  recordHistoryCapture(root, "dsh", { kind: "answer", sessionId: "dsh-1", assistantText: "dsh 答复", completed: true });
  recordHistoryCapture(root, "antigravity", { kind: "input", sessionId: "agy-1", text: "未完成提问" });

  const piFiles = new HistoryFiles(join(root, ".pbot/history"), "pi");
  const dshFiles = new HistoryFiles(join(root, ".pbot/history"), "dsh");
  const [piArchive] = piFiles.list();
  const [dshArchive] = dshFiles.list();
  assert.ok(piArchive && dshArchive);
  assert.throws(() => piFiles.saveRaw(dshArchive.raw));
  assert.throws(() => dshFiles.saveRaw(piArchive.raw));

  const service = new HistoryService(root, piFiles);
  t.after(() => service.close());
  await service.refresh();
  assert.equal(service.search().total, 3);
  assert.equal(service.search({ host: "pi", query: "第一答" }).total, 1);
  assert.equal(service.search({ host: "dsh", query: "dsh 答复" }).total, 1);
  const agySession = service.search({ host: "antigravity" }).matches[0];
  assert.equal(agySession.completed, false);

  const valid = schema(historyResultSchema);
  assert.equal(valid(service.search()), true);
  assert.equal(valid({ node: service.read(agySession.id), warnings: service.warnings }), true);
  assert.throws(() => historyInput({ action: "search", host: "Bad Host!" }));
});

test("damaged raw or summary files emit warnings while keeping valid archives searchable", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-damaged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi");
  const pi = indexHistory(sessionFixture("s1", 4, "正常问题"), undefined, "pi");
  const dsh = indexHistory(sessionFixture("s2", 4, "其他宿主"), undefined, "dsh");
  files.saveRaw(pi);
  new HistoryFiles(files.directory, "dsh").saveRaw(dsh);

  const service = new HistoryService(root, files);
  t.after(() => service.close());
  await service.refresh();
  assert.equal(service.search().total, 2);

  // Corrupt summary file: raw exchanges stay readable with a warning.
  const summaryPath = join(files.directory, "summary", pi.id + ".json");
  await writeFile(join(files.directory, "raw", "broken.json"), "{invalid json");
  await service.refresh();
  assert.equal(service.search().total, 2);
  assert.equal(service.warnings.length, 1);
  await rm(join(files.directory, "raw", "broken.json"));

  // Corrupt raw host format: rejected with warning, peer stays readable.
  const piPath = join(files.directory, "raw", pi.id + ".json");
  const original = await readFile(piPath, "utf8");
  for (const broken of [JSON.stringify({ ...pi, host: undefined }), JSON.stringify({ ...pi, host: "Bad Host!" }), "invalid JSON"]) {
    await writeFile(piPath, broken);
    await service.refresh();
    assert.equal(service.search().total, 1);
    assert.equal(service.search().matches[0].host, "dsh");
    assert.equal(service.warnings.length, 1);
  }
  await writeFile(piPath, original);
  await service.refresh();
  await service.organize(async ({ prompt }) => "摘要：" + prompt.slice(0, 12), new AbortController().signal);
  await writeFile(summaryPath, "{broken summary");
  await service.refresh();
  assert.equal(service.search({ host: "pi", query: "正常问题 0" }).total, 1);
  assert.equal(service.warnings.length, 1);
});

test("history searches all levels, pages text and children, and invalidates summaries on exchange changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-levels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi");
  const raw = indexHistory(sessionFixture("long-session", 16, "深层话题"), undefined, "pi");
  files.saveRaw(raw);

  const service = new HistoryService(root, files);
  t.after(() => service.close());
  await service.refresh();
  assert.equal(service.status.pending, 5); // 4 level-1 + 1 level-2
  await service.organize(async ({ prompt }) => "汇总：" + prompt.slice(0, 20), new AbortController().signal);
  assert.equal(service.status.pending, 0);

  const sessionHit = service.search().matches[0];
  const rootNode = service.read(sessionHit.id);
  assert.equal(rootNode.children.length, 1);
  const topSummary = service.read(rootNode.children[0].id);
  assert.equal(topSummary.kind, "summary");
  assert.equal(topSummary.children.length, 4);

  // Paging text works on exchange nodes.
  const firstChild = service.read(topSummary.children[0].id);
  const leaf = service.read(firstChild.children[0].id, 0, 10);
  assert.equal(leaf.text.length, 10);
  assert.equal(leaf.nextOffset, 10);

  // retainHistorySummaries invalidates only changed branches.
  const archive = historyView(raw, files.readArchive(raw.id).summaries);
  const savedSummaries = historySummaries(archive);
  const mutated = structuredClone(raw);
  mutated.exchanges[0].text += "\n修订";
  const retained = retainHistorySummaries(raw, mutated, savedSummaries);
  assert.equal(retained.filter(s => !s.ready).length, 2); // level-1[0] and level-2
  assert.equal(retained.filter(s => s.ready).length, 3); // other 3 level-1 summaries retained
});

test("summary splitting preserves Unicode and text across bounded segments", () => {
  const text = "你好😀世界".repeat(12);
  const parts = splitHistorySummary(text, 7);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(part => part.length > 0 && part.length <= 7));
});
