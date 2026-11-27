import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryService, commitHistorySummary } from "../../dist/services/history/history-service.js";
import { historyView, indexHistory } from "../../dist/services/history/history-index.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";

function sampleSession(sessionId, count = 4) {
  const exchanges = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.UTC(2026, 10, 27, 10, i, 0)).toISOString();
    exchanges.push({
      entryIds: [`e:${i}`],
      text: `用户：\n问题 ${i}\n\n助手：\n已存原文`,
      from: t,
      to: t,
      completed: true,
    });
  }
  return { sessionId, name: "", branches: [exchanges] };
}

function inputs(record, level = 1) {
  const summary = record.nodes.find(node => node.level === level);
  return [summary, summary.children.map(id => record.nodes.find(node => node.id === id))];
}

function storedView(files) {
  const { raw, summaries } = files.list()[0];
  return historyView(raw, summaries);
}

test("source locks are independent; a summary only replaces its derived file, even when rebuilt", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-writers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new HistoryFiles(join(root, "index"), "pi");
  const other = new HistoryFiles(files.directory, "dsh");
  const raw = indexHistory(sampleSession("sess-1", 4), undefined, "pi");
  files.saveRaw(raw);

  const initial = inputs(storedView(files));
  const marker = join(other.directory, "writer-marker");
  files.control(() => {
    assert.throws(
      () => new HistoryFiles(files.directory, "pi").control(() => writeFileSync(join(root, "must-not-write"), "blocked")),
      { code: "PBOT_HISTORY_BUSY" },
    );
    other.control(() => writeFileSync(marker, "independent"));
  });
  assert.equal(await readFile(marker, "utf8"), "independent");

  files.control(() => {
    const current = files.list()[0].raw;
    current.exchanges[0].text += "\n新增原文";
    files.saveRaw(current);
  });

  const path = join(files.directory, "raw", raw.id + ".json");
  const derived = join(files.directory, "summary", raw.id + ".json");
  const bytes = await readFile(path);
  const original = await stat(path, { bigint: true });

  // Stale snapshot is rejected without creating derived file.
  assert.equal(commitHistorySummary(files, raw, ...initial, "过期的归档摘要"), undefined);
  const snapshot = inputs(storedView(files));
  assert.throws(() => commitHistorySummary(files, raw, ...snapshot, "已取消", AbortSignal.abort()), { name: "AbortError" });
  await assert.rejects(stat(derived), { code: "ENOENT" });

  // Fresh snapshot commits via O(1) readArchive + controlSummary lock.
  assert.ok(commitHistorySummary(files, raw, ...snapshot, "已提交的归档摘要"));
  assert.equal(commitHistorySummary(files, raw, ...snapshot, "迟到的竞争结果"), undefined);
  assert.equal(files.readArchive(raw.id).summaries[0].text, "已提交的归档摘要");

  // Rebuilding after deleting derived summary never mutates the raw file.
  await rm(derived);
  const service = new HistoryService(root, files);
  t.after(() => service.close());
  await service.refresh();
  await service.organize(async () => "重建后的摘要", new AbortController().signal);
  assert.equal(files.readArchive(raw.id).summaries[0].text, "重建后的摘要");
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path, { bigint: true })).ino, original.ino);
});

test("a parent summary rejects a changed child summary and accepts a fresh snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-parent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new HistoryFiles(join(root, "index"), "pi");
  const raw = indexHistory(sampleSession("sess-16", 16), undefined, "pi");
  files.saveRaw(raw);

  // Fill all 4 level-1 summaries first.
  for (let i = 0; i < 4; i++) {
    const view = storedView(files);
    const l1 = view.nodes.find(node => node.kind === "summary" && node.level === 1 && !node.ready);
    assert.ok(l1);
    const children = l1.children.map(id => view.nodes.find(n => n.id === id));
    assert.ok(commitHistorySummary(files, raw, l1, children, `第一层摘要 ${i}`));
  }

  const before = storedView(files);
  const staleParent = inputs(before, 2);

  // Mutate one level-1 summary text behind the scenes.
  const archive = files.readArchive(raw.id);
  archive.summaries[0].text = "已被替换的底层摘要";
  files.saveSummaries(raw, archive.summaries);

  assert.equal(commitHistorySummary(files, raw, ...staleParent, "基于旧底层的上层摘要"), undefined);
  const freshParent = inputs(storedView(files), 2);
  assert.ok(commitHistorySummary(files, raw, ...freshParent, "基于新底层的上层摘要"));
  assert.equal(files.readArchive(raw.id).summaries.find(s => s.level === 2).text, "基于新底层的上层摘要");
});
