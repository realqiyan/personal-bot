import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HistoryService, commitHistorySummary } from "../../dist/services/history/history-service.js";
import { historySummaries, historyView, indexHistory } from "../../dist/services/history/history-index.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { PiHistory, projectHistory } from "../../dist/integrations/pi/history.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function exchange(manager, text) {
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", timestamp: Date.now(), usage,
    content: [{ type: "text", text: "已存原文" }], stopReason: "stop" });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-history-writers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "native"));
  for (let i = 0; i < 4; i++) exchange(manager, "问题 " + i);
  const files = new HistoryFiles(join(root, "index"));
  return { root, manager, files, location: { host: "pi", directory: manager.getSessionDir(), file: manager.getSessionFile() } };
}
function worker(code, args) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
  const ready = Promise.withResolvers(), done = Promise.withResolvers(); let output = "", errors = "";
  child.stdout.on("data", data => { output += data; if (output.includes("ready\n")) ready.resolve(); });
  child.stderr.on("data", data => { errors += data; });
  child.on("error", error => { ready.reject(error); done.reject(error); });
  child.on("close", code => {
    if (code === 0) { ready.resolve(); done.resolve(output); }
    else { const error = new Error("History worker failed: " + code + "\n" + errors); ready.reject(error); done.reject(error); }
  });
  void ready.promise.catch(() => {}); void done.promise.catch(() => {});
  return { child, ready: ready.promise, done: done.promise };
}

test("a slower native scan cannot replace a newer archive committed by another process", { timeout: 20000 }, async t => {
  const { root, manager, files, location } = await fixture(t);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  await service.refresh(location); const id = files.list()[0].raw.id;
  const slow = SessionManager.create(root, join(root, "other-native")); exchange(slow, "另一份原生记录");
  const pipe = join(root, "slow-native.jsonl"), created = spawnSync("mkfifo", [pipe], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const module = path => JSON.stringify(new URL(path, import.meta.url).href);
  // The FIFO carries real SDK JSONL. Its writer's open is an OS barrier after the scanner has read the first file.
  const scanner = worker(`
    import { HistoryService } from ${module("../../dist/services/history/history-service.js")};
    import { HistoryFiles } from ${module("../../dist/storage/history-files.js")};
    import { PiHistory } from ${module("../../dist/integrations/pi/history.js")};
    const [root, index, directory, pipe] = process.argv.slice(1);
    const service = new HistoryService(root, new HistoryFiles(index), new PiHistory(root, () => [pipe]));
    try { await service.refresh({ host: "pi", directory }); console.log(JSON.stringify(service.search())); }
    finally { await service.close(); }
  `, [root, files.directory, location.directory, pipe]);
  const writer = worker(`
    import { openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
    const data = readFileSync(process.argv[1]), fd = openSync(process.argv[2], "w");
    console.log("ready");
    process.stdin.once("data", () => { writeFileSync(fd, data); closeSync(fd); process.stdin.destroy(); });
  `, [slow.getSessionFile(), pipe]);
  try {
    await writer.ready;
    exchange(manager, "并发产生的新问题"); await service.refresh(location);
    const committed = files.list().find(value => value.raw.id === id);
    assert.equal(committed.raw.exchanges.length, 5);
    writer.child.stdin.end("release\n");
    const [output] = await Promise.all([scanner.done, writer.done]);
    assert.deepEqual(JSON.parse(output).warnings, []);
    assert.deepEqual(files.list().find(value => value.raw.id === id), committed);
    assert.equal(files.list().length, 2);
  } finally {
    for (const value of [scanner, writer]) if (value.child.exitCode === null) value.child.kill("SIGTERM");
    await Promise.allSettled([scanner.done, writer.done]);
  }
});

function inputs(record, level = 1) {
  const summary = record.nodes.find(node => node.level === level);
  return [summary, summary.children.map(id => record.nodes.find(node => node.id === id))];
}
function storedView(files) {
  const { raw, summaries } = files.list()[0];
  return historyView(raw, summaries);
}

test("source locks are independent; a summary only replaces its derived file, even when rebuilt", async t => {
  const { root, manager, files } = await fixture(t), other = new HistoryFiles(files.directory, "dsh");
  const raw = indexHistory(projectHistory(await readFile(manager.getSessionFile(), "utf8"))); files.saveRaw(raw);
  const initial = inputs(storedView(files)), marker = join(other.directory, "writer-marker");
  files.control(() => {
    assert.throws(() => new HistoryFiles(files.directory).control(() => writeFileSync(join(root, "must-not-write"), "blocked")), { code: "PBOT_HISTORY_BUSY" });
    other.control(() => writeFileSync(marker, "independent"));
  });
  assert.equal(await readFile(marker, "utf8"), "independent");
  files.control(() => {
    const current = files.list()[0].raw;
    current.exchanges[0].text += "\n新增原文"; files.saveRaw(current);
  });
  const path = join(files.directory, "raw", raw.id + ".json"), derived = join(files.directory, "summary", raw.id + ".json");
  const bytes = await readFile(path), original = await stat(path, { bigint: true });
  assert.equal(commitHistorySummary(files, raw, ...initial, "过期的归档摘要"), undefined);
  const snapshot = inputs(storedView(files));
  assert.throws(() => commitHistorySummary(files, raw, ...snapshot, "已取消", AbortSignal.abort()), { name: "AbortError" });
  await assert.rejects(stat(derived), { code: "ENOENT" });
  // Submit fixture text at the production commit boundary; no model or provider is substituted.
  assert.ok(commitHistorySummary(files, raw, ...snapshot, "已提交的归档摘要"));
  assert.equal(commitHistorySummary(files, raw, ...snapshot, "迟到的竞争结果"), undefined);
  assert.equal(files.list()[0].summaries[0].text, "已提交的归档摘要");
  await rm(derived);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  await service.refresh({ host: "pi", directory: join(root, "offline") });
  assert.equal(service.status.pending, 1);
  assert.ok(commitHistorySummary(files, raw, ...inputs(storedView(files)), "重新生成的摘要"));
  assert.equal(files.list()[0].summaries[0].text, "重新生成的摘要");
  assert.deepEqual(await readFile(path), bytes);
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, original.ino); assert.equal(after.mtimeNs, original.mtimeNs);
});

test("a summary commit checks the target, ordered children and exact source fields", async t => {
  const { manager, files } = await fixture(t);
  const raw = indexHistory(projectHistory(await readFile(manager.getSessionFile(), "utf8"))); files.saveRaw(raw);
  const snapshot = inputs(storedView(files));
  for (const change of [
    ([target]) => { target.text += "先前的摘要"; }, ([target]) => { target.completed = !target.completed; },
    ([target]) => { target.children.reverse(); }, ([, children]) => { children.reverse(); },
    ([, [child]]) => { child.entryIds[0] += "-corrected"; }, ([, [child]]) => { child.text += "原文修订"; },
    ([, [child]]) => { child.from = "2020-01-01T00:00:00.000Z"; }, ([, [child]]) => { child.to = "2100-01-01T00:00:00.000Z"; },
    ([, [child]]) => { child.completed = !child.completed; }, ([, [child]]) => { child.ready = false; },
  ]) {
    const stale = structuredClone(snapshot); change(stale);
    assert.equal(commitHistorySummary(files, raw, ...stale, "过期的结果"), undefined);
  }
  assert.deepEqual(files.list()[0].summaries, []);
});

test("a native correction retires only the saved summaries that depend on it, including ancestors", async t => {
  const { root, manager, files, location } = await fixture(t);
  for (let i = 4; i < 16; i++) exchange(manager, "问题 " + i);
  const service = new HistoryService(root, files, new PiHistory(root)); t.after(() => service.close());
  await service.refresh(location);
  const { raw } = files.list()[0], levels = historyView(raw).nodes.filter(node => node.level > 0);
  for (const { id } of levels) {
    const current = storedView(files), node = current.nodes.find(item => item.id === id);
    assert.ok(commitHistorySummary(files, raw, node, node.children.map(id => current.nodes.find(item => item.id === id)), id));
  }
  const text = "修订后的原生要求", entry = raw.exchanges[0].entryIds[0];
  const lines = (await readFile(location.file, "utf8")).trimEnd().split("\n").map(line => {
    const event = JSON.parse(line);
    if (event.id !== entry) return line;
    event.message.content = text; return JSON.stringify(event);
  });
  writeFileSync(location.file, lines.join("\n") + "\n");
  await service.refresh(location);
  assert.deepEqual(service.warnings, []);
  assert.equal(service.search({ query: text }).total, 1);
  const affected = [levels.find(node => node.children.includes(raw.exchanges[0].id)).id, levels.find(node => node.level === 2).id];
  const archived = files.list()[0];
  assert.equal(archived.raw.exchanges.length, 16); assert.equal(service.status.pending, 2);
  for (const summary of archived.summaries) {
    assert.equal(summary.ready, !affected.includes(summary.id));
    assert.equal(summary.text, summary.ready ? summary.id : "");
  }
});

test("a parent summary rejects a changed child summary and accepts a fresh snapshot", async t => {
  const { manager, files } = await fixture(t);
  for (let i = 4; i < 16; i++) exchange(manager, "上层问题 " + i);
  const raw = indexHistory(projectHistory(await readFile(manager.getSessionFile(), "utf8"))); files.saveRaw(raw);
  const view = historyView(raw);
  for (const child of view.nodes.filter(node => node.level === 1)) { child.text = "下层归档 " + child.id; child.ready = true; }
  files.saveSummaries(raw, historySummaries(view));
  const initial = inputs(storedView(files), 2);
  files.control(() => {
    const current = files.list()[0]; current.summaries.find(node => node.id === initial[1][0].id).text += "\n摘要修订";
    files.saveSummaries(raw, current.summaries);
  });
  const path = join(files.directory, "summary", raw.id + ".json"), updated = await readFile(path);
  assert.equal(commitHistorySummary(files, raw, ...initial, "过期上层摘要"), undefined);
  assert.deepEqual(await readFile(path), updated);
  assert.ok(commitHistorySummary(files, raw, ...inputs(storedView(files), 2), "新的上层归档摘要"));
  assert.equal(files.list()[0].summaries.find(node => node.id === initial[0].id).text, "新的上层归档摘要");
});
