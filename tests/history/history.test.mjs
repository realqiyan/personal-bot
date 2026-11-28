import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpHistorySummarizer } from "../../dist/integrations/acp/history-summary.js";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";
import { fingerprintExchanges, indexHistory, orderedRawExchanges } from "../../dist/services/history/history-index.js";
import { checkHistoryMigrationNotice, migrateWorkspaceHistory } from "../../dist/services/history/history-migrate.js";
import { readWorkspaceHistory, searchWorkspaceHistory, summaryNodeId } from "../../dist/services/history/history-query.js";
import { parseHistoryCommand } from "../../dist/services/history/summary-command.js";
import {
  listSummaryDimensions,
  registerSummaryDimension,
  unregisterSummaryDimension,
} from "../../dist/services/history/summary-registry.js";
import {
  checkHistorySummaryReminder,
  inspectWorkspaceSummaries,
  runWorkspaceSummaries,
} from "../../dist/services/history/summary-runner.js";
import { readWorkspaceConfig, workspaceHistoryConfig, workspaceSummaryConfig } from "../../dist/services/workspace/workspace-config.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";

function exchange(index, text = `问题 ${index}\n\n回答 ${index}`, completed = true) {
  const time = new Date(Date.UTC(2026, 10, 27, 10, index)).toISOString();
  return { entryIds: [`u${index}`, `a${index}`], text, from: time, to: time, completed };
}

test("session summary creates per-session summary, deduplicates unchanged raw, rolls incrementally, and supports force rebuild", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-summary-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "sess-a", text: "重构 summary 模块并清理所有历史遗留代码", timestamp: "2026-11-27T10:00:00.000Z" });
  recordHistoryCapture(root, "pi", {
    kind: "answer",
    sessionId: "sess-a",
    assistantText: "详细技术说明：先清理旧格式存储，再实现按会话维度的任务摘要，最后补充并发调度与去重指纹逻辑。旧正文唯一标记OLD_BODY_SENTINEL。",
    completed: true,
    timestamp: "2026-11-27T10:01:00.000Z",
  });
  recordHistoryCapture(root, "claude", { kind: "input", sessionId: "sess-b", text: "检查依赖边界", timestamp: "2026-11-27T10:02:00.000Z" });
  recordHistoryCapture(root, "claude", { kind: "answer", sessionId: "sess-b", assistantText: "dependency-cruiser 全部通过。", completed: true, timestamp: "2026-11-27T10:03:00.000Z" });

  const initialStatus = inspectWorkspaceSummaries(root);
  assert.equal(initialStatus.rawCount, 2);
  assert.equal(initialStatus.dimensions[0].dimension, "session");
  assert.equal(initialStatus.dimensions[0].pendingCreate, 2);
  assert.equal(initialStatus.dimensions[0].ready, 0);

  const calls = [];
  const summarizer = async ({ prompt }) => {
    calls.push(prompt);
    if (prompt.includes("月份：")) return "2026年11月汇总：完成 summary 重构与依赖检查。";
    if (prompt.includes("重构 summary")) return "摘要A：完成 summary 模块按会话重构设计。";
    return "摘要B：依赖边界检查全部通过。";
  };

  // 1. Initial run creates both session summaries and the monthly summary.
  const first = await runWorkspaceSummaries({ root, summarizer });
  assert.equal(first.dimensions[0].dimension, "session");
  assert.equal(first.dimensions[0].created, 2);
  assert.equal(first.dimensions[0].skipped, 0);
  assert.equal(first.dimensions[0].failed.length, 0);
  assert.equal(first.dimensions[1].dimension, "monthly");
  assert.equal(first.dimensions[1].created, 1);
  assert.equal(calls.length, 3);

  // 2. Re-running with unchanged RAW skips everything (0 LLM calls).
  calls.length = 0;
  const second = await runWorkspaceSummaries({ root, summarizer });
  assert.equal(second.dimensions[0].skipped, 2);
  assert.equal(second.dimensions[0].created, 0);
  assert.equal(second.dimensions[0].incremental, 0);
  assert.equal(second.dimensions[1].skipped, 1);
  assert.equal(calls.length, 0);

  // 3. Appending a new turn to sess-a triggers rolling incremental update and rebuilds monthly summary.
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "sess-a", text: "补充去重和 rg 搜索", timestamp: "2026-11-27T10:05:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "sess-a", assistantText: "已加入 SHA-256 指纹去重与 rg 预过滤。", completed: true, timestamp: "2026-11-27T10:06:00.000Z" });

  const midStatus = inspectWorkspaceSummaries(root);
  assert.equal(midStatus.layout, "monthly");
  assert.equal(midStatus.dimensions[0].ready, 1);
  assert.equal(midStatus.dimensions[0].pendingIncremental, 1);

  calls.length = 0;
  const third = await runWorkspaceSummaries({
    root,
    summarizer: async ({ prompt }) => {
      calls.push(prompt);
      if (prompt.includes("月份：")) return "2026年11月汇总（更新）：补充去重指纹与 rg 搜索隔离。";
      return "摘要A（更新）：完成按会话重构、SHA-256 指纹去重与 rg 搜索隔离。";
    },
  });
  assert.equal(third.dimensions[0].skipped, 1);
  assert.equal(third.dimensions[0].incremental, 1);
  assert.equal(third.dimensions[1].rebuilt, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("已有摘要"));
  assert.ok(calls[0].includes("补充去重和 rg 搜索"));
  assert.ok(!calls[0].includes("OLD_BODY_SENTINEL"));

  // 4. Force run rebuilds all sessions and monthly summaries regardless of matching fingerprints.
  calls.length = 0;
  const forced = await runWorkspaceSummaries({ root, summarizer, force: true });
  assert.equal(forced.dimensions[0].rebuilt, 2);
  assert.equal(forced.dimensions[0].skipped, 0);
  assert.equal(forced.dimensions[1].rebuilt, 1);
  assert.equal(calls.length, 3);

  // Verify storage layout uses YYYY/MM subdirectories under raw/ and summaries/<dimension>/.
  const topDirs = (await readdir(join(root, ".pbot/history"))).sort();
  assert.deepEqual(topDirs, ["raw", "summaries"]);
  assert.deepEqual(await readdir(join(root, ".pbot/history/raw")), ["2026"]);
  assert.deepEqual(await readdir(join(root, ".pbot/history/raw/2026")), ["11"]);
  const dimDirs = (await readdir(join(root, ".pbot/history/summaries"))).sort();
  assert.deepEqual(dimDirs, ["monthly", "session"]);
  assert.deepEqual(await readdir(join(root, ".pbot/history/summaries/monthly/2026")), ["2026-11.json"]);
});

test("custom summary dimensions can be registered, executed, and queried independently", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-dims-")));
  t.after(() => {
    unregisterSummaryDimension("decisions");
    return rm(root, { recursive: true, force: true });
  });

  const files = new HistoryFiles(join(root, ".pbot/history"), "pi");
  const raw = indexHistory({ sessionId: "s1", name: "架构评审", branches: [[exchange(1, "决定采用注册表模式")]] }, undefined, "pi");
  files.saveRaw(raw);

  registerSummaryDimension({
    id: "decisions",
    title: "关键决策摘要",
    description: "提取跨会话架构决定",
    plan(raws, existing, { force = false } = {}) {
      const tasks = [];
      let skipped = 0;
      for (const item of raws) {
        const ordered = orderedRawExchanges(item);
        const fingerprint = fingerprintExchanges(ordered);
        const prev = existing.get(item.id);
        if (!force && prev?.source.fingerprint === fingerprint) { skipped++; continue; }
        tasks.push({
          id: item.id,
          dimension: "decisions",
          mode: prev ? "rebuild" : "create",
          title: item.name,
          host: item.host,
          sessionId: item.sessionId,
          from: ordered[0].from,
          to: ordered.at(-1).to,
          source: { rawIds: [item.id], exchangeIds: ordered.map(e => e.id), fingerprint },
          exchanges: ordered,
        });
      }
      return { tasks, skipped };
    },
    buildRequest(task) {
      return { system: "提取决策", prompt: task.exchanges.map(e => e.text).join("\n"), maxTokens: 512 };
    },
    finalize(task, output, now) {
      return {
        id: task.id,
        dimension: "decisions",
        host: task.host,
        sessionId: task.sessionId,
        title: task.title,
        text: output.trim(),
        from: task.from,
        to: task.to,
        updatedAt: now,
        source: task.source,
      };
    },
  });

  assert.ok(listSummaryDimensions().some(d => d.id === "decisions"));

  const report = await runWorkspaceSummaries({
    root,
    dimensions: ["decisions"],
    summarizer: async () => "决策记录：使用 SummaryRegistry 支持多维度摘要扩展。",
  });
  assert.equal(report.dimensions.length, 1);
  assert.equal(report.dimensions[0].dimension, "decisions");
  assert.equal(report.dimensions[0].created, 1);

  const hitGlobal = searchWorkspaceHistory(root, { query: "SummaryRegistry" });
  assert.equal(hitGlobal.total, 1);
  assert.equal(hitGlobal.matches[0].kind, "summary");
  assert.equal(hitGlobal.matches[0].dimension, "decisions");

  const hitRawOnly = searchWorkspaceHistory(root, { query: "SummaryRegistry", dimension: "raw" });
  assert.equal(hitRawOnly.total, 0);

  const hitDimList = searchWorkspaceHistory(root, { dimension: "decisions" });
  assert.equal(hitDimList.total, 1);

  const summaryNode = readWorkspaceHistory(root, summaryNodeId("decisions", raw.id));
  assert.equal(summaryNode.kind, "summary");
  assert.equal(summaryNode.dimension, "decisions");
  assert.equal(summaryNode.parents[0].id, raw.id);
  assert.equal(summaryNode.children.length, 1);

  const sessionNode = readWorkspaceHistory(root, raw.id);
  assert.equal(sessionNode.kind, "session");
  assert.equal(sessionNode.children[0].kind, "summary");
  assert.equal(sessionNode.children[1].kind, "exchange");

  const exchangeNode = readWorkspaceHistory(root, raw.exchanges[0].id);
  assert.equal(exchangeNode.kind, "exchange");
  assert.ok(exchangeNode.parents.some(p => p.id === raw.id));
  assert.ok(exchangeNode.parents.some(p => p.id === summaryNodeId("decisions", raw.id)));
});

test("createAcpHistorySummarizer spawns one isolated ACP worker per session with PBOT_SUBAGENT_RUN_ID and optional model override", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-acp-summary-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const logFile = join(root, "worker-invocations.jsonl");
  const acpScript = join(root, "local-acp.mjs");
  await writeFile(acpScript, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = process.env.SUMMARY_TEST_LOG;
const rl = readline.createInterface({ input: process.stdin });
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
let configuredModel = null;

rl.on("line", line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { systemPrompt: true, close: true } },
      },
    });
  } else if (req.method === "session/new") {
    const sid = "acp-sess-" + process.pid;
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        sessionId: sid,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default/model",
            options: [
              { value: "default/model", name: "Default Model" },
              { value: "fast/model", name: "Fast Model" },
            ],
          },
        ],
        _meta: {
          piAcp: {
            startupInfo: "pi v1.6.1\\n---\\n\\n## Context\\n- AGENTS.md\\n",
          },
        },
      },
    });
  } else if (req.method === "session/set_config_option") {
    configuredModel = req.params.value;
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: configuredModel,
            options: [
              { value: "default/model", name: "Default Model" },
              { value: "fast/model", name: "Fast Model" },
            ],
          },
        ],
      },
    });
  } else if (req.method === "session/prompt") {
    appendFileSync(logPath, JSON.stringify({
      pid: process.pid,
      subagentRunId: process.env.PBOT_SUBAGENT_RUN_ID ?? null,
      configuredModel,
    }) + "\\n");
    const text = req.params.prompt[0]?.text ?? "";
    const tag = text.includes("会话一") ? "摘要一" : "摘要二";
    // Simulate pi-acp flushing startupInfo inside the first prompt turn.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pi v1.6.1\\n---\\n\\n## Context\\n- AGENTS.md\\n" } },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: tag + "：" + (configuredModel ?? "default") } },
      },
    });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  } else if (req.method === "session/close") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
`);
  await chmod(acpScript, 0o755);

  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "s-one", text: "会话一：需求讨论", timestamp: "2026-11-27T12:00:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "s-one", assistantText: "会话一完成。", completed: true, timestamp: "2026-11-27T12:01:00.000Z" });
  recordHistoryCapture(root, "dsh", { kind: "input", sessionId: "s-two", text: "会话二：接口设计", timestamp: "2026-11-27T12:02:00.000Z" });
  recordHistoryCapture(root, "dsh", { kind: "answer", sessionId: "s-two", assistantText: "会话二完成。", completed: true, timestamp: "2026-11-27T12:03:00.000Z" });

  const commands = {
    "summary-test": { command: process.execPath, args: [acpScript], env: { SUMMARY_TEST_LOG: logFile } },
  };

  // Default model (no override): spawns 2 isolated workers with distinct PIDs and PBOT_SUBAGENT_RUN_ID set.
  const summarizerDefault = createAcpHistorySummarizer({ cwd: root, backend: "summary-test", commands });
  const firstRun = await runWorkspaceSummaries({ root, dimensions: ["session"], summarizer: summarizerDefault, concurrency: 2 });
  assert.equal(firstRun.dimensions[0].created, 2);
  assert.equal(firstRun.dimensions[0].failed.length, 0);

  const logs = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.notEqual(logs[0].pid, logs[1].pid);
  assert.ok(logs.every(entry => typeof entry.subagentRunId === "string" && entry.subagentRunId.startsWith("pbot-summary-")));
  assert.ok(logs.every(entry => entry.configuredModel === null));
  // Summary runs must not create any extra raw history files.
  assert.equal((await readdir(join(root, ".pbot/history/raw/2026/11"))).length, 2);

  // Model override with --force applies set_config_option.
  const summarizerOverride = createAcpHistorySummarizer({ cwd: root, backend: "summary-test", commands, model: "fast/model" });
  const forcedRun = await runWorkspaceSummaries({ root, dimensions: ["session"], summarizer: summarizerOverride, force: true, concurrency: 2 });
  assert.equal(forcedRun.dimensions[0].rebuilt, 2);
  const hit = searchWorkspaceHistory(root, { query: "摘要一：fast/model", dimension: "session" });
  assert.equal(hit.total, 1);
  assert.equal(hit.matches[0].snippet.includes("pi v1.6.1"), false);
});

test("workspace summary config defaults to pi and validates optional overrides", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-summary-cfg-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(workspaceSummaryConfig(undefined), { backend: "pi", concurrency: 3 });

  await mkdir(join(root, ".pbot"), { recursive: true });
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    summary: { backend: "dsh", model: "deepseek-v4-flash", thinking: "low", concurrency: 4 },
  }));
  const cfg = await readWorkspaceConfig(root);
  assert.equal(cfg.error, undefined);
  assert.deepEqual(workspaceSummaryConfig(cfg), {
    backend: "dsh",
    model: "deepseek-v4-flash",
    thinking: "low",
    concurrency: 4,
  });

  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    summary: { concurrency: 99 },
  }));
  const invalid = await readWorkspaceConfig(root);
  assert.equal(invalid.enabled, false);
  assert.ok(invalid.error?.includes("summary.concurrency"));
});

test("parseHistoryCommand handles status, list, migrate, summary options, and JSON queries", () => {
  assert.deepEqual(parseHistoryCommand(""), { kind: "status" });
  assert.deepEqual(parseHistoryCommand("status"), { kind: "status" });
  assert.deepEqual(parseHistoryCommand("list"), { kind: "list" });
  assert.deepEqual(parseHistoryCommand("migrate"), { kind: "migrate", dryRun: false });
  assert.deepEqual(parseHistoryCommand("migrate --dry-run"), { kind: "migrate", dryRun: true });
  assert.deepEqual(parseHistoryCommand("summary"), { kind: "summary", force: false });
  assert.deepEqual(
    parseHistoryCommand("summary session --force --backend dsh --model flash --thinking low"),
    { kind: "summary", dimensions: ["session"], force: true, backend: "dsh", model: "flash", thinking: "low" },
  );
  assert.deepEqual(parseHistoryCommand('{"action":"search","query":"abc"}'), { kind: "query", input: { action: "search", query: "abc" } });
  assert.throws(() => parseHistoryCommand("migrate --unknown"));
  assert.throws(() => parseHistoryCommand("summary --unknown"));
  assert.throws(() => parseHistoryCommand("summary --backend"));
  assert.throws(() => parseHistoryCommand("invalid"));
});

test("checkHistorySummaryReminder triggers only when raw history >= 7 days, no summary ran in 7 days, and pending work exists", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-summary-reminder-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const now = new Date("2026-11-28T00:00:00.000Z");

  // 1. No raw files -> no reminder.
  assert.equal(checkHistorySummaryReminder(root, { now }), undefined);

  // 2. Raw history exists for 6 days (< 7 days) -> no reminder.
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "recent-sess", text: "六天前的问题", timestamp: "2026-11-22T00:00:01.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "recent-sess", assistantText: "六天前的回答", completed: true, timestamp: "2026-11-22T00:05:00.000Z" });
  assert.equal(checkHistorySummaryReminder(root, { now }), undefined);

  // 3. Raw history exists for 10 days (>= 7 days) and summary never ran -> triggers reminder.
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "old-sess", text: "十天前的问题", timestamp: "2026-11-18T00:00:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "old-sess", assistantText: "十天前的回答", completed: true, timestamp: "2026-11-18T00:05:00.000Z" });
  const neverRun = checkHistorySummaryReminder(root, { now });
  assert.ok(neverRun);
  assert.equal(neverRun.rawCount, 2);
  assert.equal(neverRun.pendingCount, 2);
  assert.equal(neverRun.rawAgeDays, 10);
  assert.equal(neverRun.latestSummaryAt, undefined);
  assert.equal(neverRun.daysSinceLastSummary, undefined);
  assert.equal(neverRun.thresholdDays, 7);
  assert.ok(neverRun.message.includes("/pbot history summary"));

  const inspected = inspectWorkspaceSummaries(root, { now });
  assert.deepEqual(inspected.reminder, neverRun);

  // 4. Summary ran recently (< 7 days ago) -> no reminder even when new raw turns are pending.
  await runWorkspaceSummaries({ root, summarizer: async () => "摘要正文" });
  // Simulate summary updatedAt = 3 days before `now` and add a new pending raw session.
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi");
  for (const dim of ["session", "monthly"]) {
    for (const artifact of files.listSummaries(dim)) {
      files.saveSummary({ ...artifact, updatedAt: "2026-11-25T00:00:00.000Z" });
    }
  }
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "new-sess", text: "昨天的新问题", timestamp: "2026-11-27T10:00:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "new-sess", assistantText: "昨天的新回答", completed: true, timestamp: "2026-11-27T10:01:00.000Z" });
  assert.equal(checkHistorySummaryReminder(root, { now }), undefined);

  // 5. Summary ran 8 days ago (>= 7 days), and there IS pending raw work -> triggers reminder.
  for (const dim of ["session", "monthly"]) {
    for (const artifact of files.listSummaries(dim)) {
      files.saveSummary({ ...artifact, updatedAt: "2026-11-20T00:00:00.000Z" });
    }
  }
  const stale = checkHistorySummaryReminder(root, { now });
  assert.ok(stale);
  assert.equal(stale.pendingCount, 1);
  assert.equal(stale.rawAgeDays, 10);
  assert.equal(stale.daysSinceLastSummary, 8);
  assert.equal(stale.latestSummaryAt, "2026-11-20T00:00:00.000Z");

  // 6. All sessions summarized, even if latest summary is 8 days old -> no pending work, no reminder.
  await runWorkspaceSummaries({ root, summarizer: async () => "最新摘要正文" });
  for (const dim of ["session", "monthly"]) {
    for (const artifact of files.listSummaries(dim)) {
      files.saveSummary({ ...artifact, updatedAt: "2026-11-20T00:00:00.000Z" });
    }
  }
  assert.equal(checkHistorySummaryReminder(root, { now }), undefined);
});

test("history.layout supports monthly (default) and flat, enforces strict layout isolation, and disables monthly summaries in flat mode", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(workspaceHistoryConfig(undefined), { layout: "monthly" });

  // Validate invalid history.layout config.
  await mkdir(join(root, ".pbot"), { recursive: true });
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true, history: { layout: "yearly" } }));
  const badCfg = await readWorkspaceConfig(root);
  assert.equal(badCfg.enabled, false);
  assert.ok(badCfg.error?.includes("history.layout"));

  // Switch to flat layout: writes flat, does not generate monthly summary, rejects explicit monthly dimension.
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true, history: { layout: "flat" } }));
  const flatCfg = await readWorkspaceConfig(root);
  assert.equal(flatCfg.enabled, true);
  assert.deepEqual(workspaceHistoryConfig(flatCfg), { layout: "flat" });

  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "flat-sess", text: "平铺布局会话", timestamp: "2026-10-15T08:00:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "flat-sess", assistantText: "平铺回答内容", completed: true, timestamp: "2026-10-15T08:01:00.000Z" });

  const flatRawNames = await readdir(join(root, ".pbot/history/raw"));
  assert.equal(flatRawNames.length, 1);
  assert.ok(flatRawNames[0].endsWith(".json"));

  const flatStatus = inspectWorkspaceSummaries(root);
  assert.equal(flatStatus.layout, "flat");
  assert.deepEqual(flatStatus.dimensions.map(d => d.dimension), ["session"]);
  assert.equal(checkHistoryMigrationNotice(root), undefined);

  const flatSummary = await runWorkspaceSummaries({ root, summarizer: async () => "平铺单会话摘要" });
  assert.deepEqual(flatSummary.dimensions.map(d => d.dimension), ["session"]);
  assert.equal(flatSummary.dimensions[0].created, 1);
  assert.deepEqual(await readdir(join(root, ".pbot/history/summaries")), ["session"]);
  assert.ok((await readdir(join(root, ".pbot/history/summaries/session"))).every(n => n.endsWith(".json")));

  await assert.rejects(
    runWorkspaceSummaries({ root, dimensions: ["monthly"], summarizer: async () => "unreachable" }),
    /monthly/,
  );
  assert.throws(() => migrateWorkspaceHistory(root), /flat/);

  // Switch config to monthly WITHOUT migrating: flat files are NOT mixed-read, and all warning channels report them.
  const configBefore = JSON.stringify({ enabled: true, history: { layout: "monthly" } });
  await writeFile(join(root, ".pbot/config.json"), configBefore);

  assert.equal(searchWorkspaceHistory(root).total, 0);
  const searchWarn = searchWorkspaceHistory(root).warnings;
  assert.ok(searchWarn.some(w => w.includes("/pbot history migrate")));
  assert.ok(checkHistoryMigrationNotice(root)?.includes("/pbot history migrate"));
  const statusWarn = inspectWorkspaceSummaries(root).warnings;
  assert.ok(statusWarn.some(w => w.includes("/pbot history migrate")));

  // Dry-run migrate reports planned moves without touching files.
  const dryRun = migrateWorkspaceHistory(root, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.moved.length, 2);
  assert.equal((await readdir(join(root, ".pbot/history/raw"))).filter(n => n.endsWith(".json")).length, 1);

  // Explicit migrate moves raw + summary directly into 2026/10/ with zero duplicates and untouched config.json.
  const migrated = migrateWorkspaceHistory(root);
  assert.equal(migrated.dryRun, false);
  assert.deepEqual(migrated.moved, dryRun.moved);
  assert.equal(migrated.skipped.length, 0);
  assert.equal(migrated.errors.length, 0);
  assert.equal(await readFile(join(root, ".pbot/config.json"), "utf8"), configBefore);
  assert.equal((await readdir(join(root, ".pbot/history/raw"))).filter(n => n.endsWith(".json")).length, 0);
  assert.equal((await readdir(join(root, ".pbot/history/raw/2026/10"))).length, 1);
  assert.equal((await readdir(join(root, ".pbot/history/summaries/session/2026/10"))).length, 1);
  assert.equal(checkHistoryMigrationNotice(root), undefined);
  assert.equal(searchWorkspaceHistory(root).total, 1);
  assert.equal(searchWorkspaceHistory(root).warnings.length, 0);
});

test("monthly layout keeps cross-month sessions in start bucket, falls back to unknown/, and drills down monthly -> session -> exchange", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-history-monthly-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Cross-month session: starts in Oct UTC, continues in Nov UTC -> stays in 2026/10/.
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "cross-month", text: "十月底发起跨月任务", timestamp: "2026-10-31T23:50:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "cross-month", assistantText: "十月初步方案。", completed: true, timestamp: "2026-10-31T23:55:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "input", sessionId: "cross-month", text: "十一月继续推进", timestamp: "2026-11-01T00:10:00.000Z" });
  recordHistoryCapture(root, "pi", { kind: "answer", sessionId: "cross-month", assistantText: "十一月收尾完成。", completed: true, timestamp: "2026-11-01T00:15:00.000Z" });

  // Second session in Nov UTC.
  recordHistoryCapture(root, "claude", { kind: "input", sessionId: "nov-sess", text: "十一月独立任务", timestamp: "2026-11-05T10:00:00.000Z" });
  recordHistoryCapture(root, "claude", { kind: "answer", sessionId: "nov-sess", assistantText: "十一月任务完成。", completed: true, timestamp: "2026-11-05T10:05:00.000Z" });

  // Session missing timestamps -> falls back to unknown/.
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", "monthly");
  const undated = indexHistory({
    sessionId: "undated-sess",
    name: "无时间戳会话",
    branches: [[{ entryIds: ["u1", "a1"], text: "无时间内容", from: "", to: "", completed: true }]],
  }, undefined, "pi");
  files.saveRaw(undated);

  assert.equal((await readdir(join(root, ".pbot/history/raw/2026/10"))).length, 1);
  assert.equal((await readdir(join(root, ".pbot/history/raw/2026/11"))).length, 1);
  assert.equal((await readdir(join(root, ".pbot/history/raw/unknown"))).length, 1);

  const report = await runWorkspaceSummaries({
    root,
    summarizer: async ({ prompt }) => {
      if (prompt.includes("月份：2026-10")) return "十月月度汇总：跨月任务在十月启动。";
      if (prompt.includes("月份：2026-11")) return "十一月月度汇总：完成十一月独立任务。";
      if (prompt.includes("跨月任务")) return "跨月会话摘要：十月启动、十一月收尾。";
      if (prompt.includes("独立任务")) return "十一月会话摘要：独立任务完成。";
      return "无时间戳会话摘要。";
    },
  });
  assert.equal(report.dimensions[0].created, 3);
  assert.equal(report.dimensions[1].dimension, "monthly");
  assert.equal(report.dimensions[1].created, 2); // 2026-10 and 2026-11; unknown/ excluded from monthly.

  // Search monthly summaries directly.
  const monthlyList = searchWorkspaceHistory(root, { dimension: "monthly" });
  assert.equal(monthlyList.total, 2);
  assert.deepEqual(monthlyList.matches.map(m => m.id), ["summary:monthly:2026-11", "summary:monthly:2026-10"]);

  const monthlySearch = searchWorkspaceHistory(root, { query: "十月月度汇总" });
  assert.equal(monthlySearch.total, 1);
  assert.equal(monthlySearch.matches[0].id, "summary:monthly:2026-10");
  assert.deepEqual(monthlySearch.matches[0].parents, []);

  // Drill down: monthly -> session summary -> exchange.
  const match = monthlySearch.matches[0];
  const octNode = readWorkspaceHistory(root, match.id, 0, undefined, 0, match.host);
  for (const query of ["", "十月月度汇总"]) {
    const filtered = searchWorkspaceHistory(root, { dimension: "monthly", query, host: match.host, sessionId: match.sessionId });
    assert.deepEqual(filtered.matches.map(item => item.id), [match.id]);
  }
  assert.throws(() => readWorkspaceHistory(root, match.id, 0, undefined, 0, "dsh"));
  assert.equal(octNode.dimension, "monthly");
  assert.deepEqual(octNode.parents, []);
  assert.equal(octNode.children.length, 1);
  assert.equal(octNode.children[0].kind, "summary");
  assert.equal(octNode.children[0].dimension, "session");

  const sessionSummaryNode = readWorkspaceHistory(root, octNode.children[0].id);
  assert.ok(sessionSummaryNode.parents.some(p => p.id === "summary:monthly:2026-10"));
  assert.equal(sessionSummaryNode.children.length, 2);
  assert.equal(sessionSummaryNode.children[0].kind, "exchange");

  const sessionRootNode = readWorkspaceHistory(root, sessionSummaryNode.parents.find(p => p.kind === "session").id);
  assert.ok(sessionRootNode.parents.some(p => p.id === "summary:monthly:2026-10"));

  const exchangeNode = readWorkspaceHistory(root, sessionSummaryNode.children[0].id);
  assert.equal(exchangeNode.kind, "exchange");
  assert.ok(exchangeNode.text.includes("十月底发起跨月任务"));
});
