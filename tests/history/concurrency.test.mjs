import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexHistory } from "../../dist/services/history/history-index.js";
import { runWorkspaceSummaries } from "../../dist/services/history/summary-runner.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";

function makeExchange(index) {
  const time = new Date(Date.UTC(2026, 10, 27, 11, index)).toISOString();
  return { entryIds: [`u${index}`, `a${index}`], text: `并发测试对话 ${index}`, from: time, to: time, completed: true };
}

test("raw host locks and dimension summary locks serialize conflicts without blocking other hosts or dimensions", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const piFiles = new HistoryFiles(join(root, ".pbot/history"), "pi");
  const dshFiles = new HistoryFiles(join(root, ".pbot/history"), "dsh");

  piFiles.control(() => {
    // Same host lock is busy.
    assert.throws(
      () => new HistoryFiles(piFiles.directory, "pi").control(() => writeFileSync(join(root, "blocked"), "no")),
      { code: "PBOT_HISTORY_BUSY" },
    );
    // Different host raw lock succeeds independently.
    assert.equal(dshFiles.control(() => "ok"), "ok");
    // Dimension summary lock is independent of raw host lock.
    piFiles.controlSummary("session", () => {
      assert.throws(
        () => dshFiles.controlSummary("session", () => "blocked"),
        { code: "PBOT_HISTORY_BUSY" },
      );
      assert.equal(dshFiles.controlSummary("daily", () => "ok"), "ok");
    });
  });
});

test("runWorkspaceSummaries executes tasks concurrently, isolates per-task failures, and respects AbortSignal", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-concurrency-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const files = new HistoryFiles(join(root, ".pbot/history"), "pi");
  for (let i = 1; i <= 5; i++) {
    const raw = indexHistory({ sessionId: `s-${i}`, name: `会话 ${i}`, branches: [[makeExchange(i)]] }, undefined, "pi");
    files.saveRaw(raw);
  }

  let active = 0;
  let maxActive = 0;
  const progressEvents = [];

  const report = await runWorkspaceSummaries({
    root,
    concurrency: 3,
    onProgress: event => progressEvents.push(event),
    summarizer: async ({ prompt }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--;
      if (prompt.includes("会话 3")) throw new Error("单条模型失败");
      return "摘要结果：" + prompt.slice(0, 20);
    },
  });

  assert.ok(maxActive >= 2, `expected concurrent execution, got maxActive=${maxActive}`);
  assert.equal(report.dimensions[0].created, 4);
  assert.equal(report.dimensions[0].failed.length, 1);
  assert.equal(progressEvents.length, 5);

  // Cancellation stops pending work cleanly.
  const controller = new AbortController();
  await assert.rejects(
    runWorkspaceSummaries({
      root,
      force: true,
      concurrency: 1,
      signal: controller.signal,
      summarizer: async (_req, signal) => {
        controller.abort();
        signal.throwIfAborted();
        return "unreachable";
      },
    }),
    { name: "AbortError" },
  );
});
