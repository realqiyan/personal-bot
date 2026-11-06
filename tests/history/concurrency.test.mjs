import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HistoryService, completeHistorySummary, indexHistory } from "../../dist/services/history/history-service.js";
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
  return { root, manager, files, location: { directory: manager.getSessionDir(), file: manager.getSessionFile() } };
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
  await service.refresh(location); const id = files.list()[0].id;
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
    try { await service.refresh({ directory }); console.log(JSON.stringify(service.search())); }
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
    const committed = files.list().find(value => value.id === id);
    assert.equal(committed.nodes.filter(value => value.kind === "exchange").length, 5);
    writer.child.stdin.end("release\n");
    const [output] = await Promise.all([scanner.done, writer.done]);
    assert.deepEqual(JSON.parse(output).warnings, []);
    assert.deepEqual(files.list().find(value => value.id === id), committed);
    assert.equal(files.list().length, 2);
  } finally {
    for (const value of [scanner, writer]) if (value.child.exitCode === null) value.child.kill("SIGTERM");
    await Promise.allSettled([scanner.done, writer.done]);
  }
});

test("source locks are independent and summary commits reject changed inputs or an already saved result", async t => {
  const { root, manager, files } = await fixture(t), other = new HistoryFiles(join(root, "dsh-index"), "dsh");
  const record = indexHistory(projectHistory(await readFile(manager.getSessionFile(), "utf8"))); files.save(record);
  const summary = record.nodes.find(value => value.kind === "summary"), children = summary.children.map(id => record.nodes.find(value => value.id === id));
  const marker = join(other.directory, "writer-marker");
  files.control(() => {
    assert.throws(() => new HistoryFiles(files.directory).control(() => writeFileSync(join(root, "must-not-write"), "blocked")), { code: "PBOT_HISTORY_BUSY" });
    other.control(() => writeFileSync(marker, "independent"));
  });
  assert.equal(await readFile(marker, "utf8"), "independent");
  files.control(() => {
    const current = files.list()[0]; current.nodes.find(value => value.id === children[0].id).text += "\n新增原文";
    files.save(current);
  });
  const path = join(files.directory, record.id + ".json"), changed = await readFile(path, "utf8");
  files.control(() => { assert.equal(completeHistorySummary(files.list()[0], summary.id, children, "过期的归档摘要"), false); });
  assert.equal(await readFile(path, "utf8"), changed);
  // These are persisted archive fixtures, not a replacement for a summarizer or model.
  files.control(() => {
    const current = files.list()[0], inputs = summary.children.map(id => current.nodes.find(value => value.id === id));
    assert.equal(completeHistorySummary(current, summary.id, inputs, "已提交的归档摘要"), true); files.save(current);
    assert.equal(completeHistorySummary(current, summary.id, inputs, "迟到的竞争结果"), false);
  });
  assert.equal(files.list()[0].nodes.find(value => value.id === summary.id).text, "已提交的归档摘要");
});
