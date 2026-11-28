import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import * as pbot from "../../dist/dsh.js";
import { initializeWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";
import { readWorkspaceHistory, searchWorkspaceHistory } from "../../dist/services/history/history-query.js";
import { runWorkspaceSummaries } from "../../dist/services/history/summary-runner.js";

function emitDshExchange(session, turn, question, answer) {
  session.append("turn/start", { turn });
  session.append("step/start", { turn, step: 1 });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: question }], source: { kind: "user" } }), { surfaceOp: "append" });
  session.append("assistant/message", {
    turn,
    step: 1,
    interrupted: false,
    message: createAssistantMessage({ content: [{ type: "text", text: answer }], source: { provider: "deepseek-official", model: "deepseek-flash" } }),
    stream: [
      { type: "text-chunks", index: 0, time0: Date.now(), dt: [0], texts: [answer] },
      { type: "chunk", time: Date.now(), chunk: { type: "finish", reason: { kind: "stop" } } },
    ],
  }, { surfaceOp: "append" });
  session.append("step/end", { turn, step: 1 });
  session.append("turn/end", { turn, reason: { kind: "completed" } });
}

test("dsh records root-session raw history, keeps idle silent, and exposes /pbot history commands and pbot_history tool", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-history-")));
  const saved = { DSH_HOME: process.env.DSH_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  Object.assign(process.env, { HOME: join(root, "user"), XDG_DATA_HOME: join(root, "user/data"), DSH_HOME: join(root, "home") });
  await initializeWorkspaceConfig(root);
  const host = await dshHost(join(root, "sessions"));
  t.after(async () => {
    await host.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  await host.ctx.plugin(pbot);
  const parentHandle = await host.ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: root },
    agentOptions: { provider: "not-configured", model: "none" },
  });
  const parent = parentHandle.agent;
  t.after(() => parentHandle.dispose());

  // Emit a completed root-session turn.
  emitDshExchange(parent.session, 1, "请记录这条 dsh 对话", "已经记录完成。");

  // Raw file is written immediately under YYYY/MM/, and NO summary is generated automatically on idle.
  const rawNames = (await readdir(join(root, ".pbot/history/raw"), { recursive: true })).filter(name => name.endsWith(".json"));
  assert.equal(rawNames.length, 1);
  assert.ok(rawNames[0].includes("dsh-"));
  await assert.rejects(readdir(join(root, ".pbot/history/summaries")));

  const signal = new AbortController().signal;
  const runCmd = async command => {
    const output = await host.ctx.commands.execute(parent, command, [], signal);
    assert.equal(output.result.kind, "success", output.result.text);
    return JSON.parse(output.result.text);
  };

  // /pbot history status & list commands.
  const status = await runCmd("/pbot history status");
  assert.equal(status.rawCount, 1);
  assert.equal(status.dimensions[0].dimension, "session");
  assert.equal(status.dimensions[0].pendingCreate, 1);

  const dims = await runCmd("/pbot history list");
  assert.equal(dims.layout, "monthly");
  assert.ok(dims.dimensions.some(d => d.id === "session"));
  assert.ok(dims.dimensions.some(d => d.id === "monthly"));

  const migrateEmpty = await runCmd("/pbot history migrate --dry-run");
  assert.equal(migrateEmpty.dryRun, true);
  assert.equal(migrateEmpty.moved.length, 0);

  // Explicit summary run generates the session summary and monthly summary.
  const summaryReport = await runWorkspaceSummaries({
    root,
    summarizer: async ({ prompt }) => prompt.includes("月份：")
      ? "dsh 月度汇总：本月验证了历史采集链路。"
      : "dsh 会话摘要：验证了根会话原文采集与查询。",
  });
  assert.equal(summaryReport.dimensions[0].created, 1);
  assert.equal(summaryReport.dimensions[1].dimension, "monthly");
  assert.equal(summaryReport.dimensions[1].created, 1);

  // Up-to-date summaries take the real command path without starting an ACP process.
  const skipped = await runCmd("/pbot history summary session --backend dsh --model custom-model");
  assert.equal(skipped.backend, "dsh");
  assert.equal(skipped.model, "custom-model");
  assert.equal(skipped.dimensions[0].skipped, 1);

  // /pbot history JSON query searches both raw and summaries.
  const searchResult = await runCmd('/pbot history {"action":"search","query":"验证了根会话"}');
  assert.equal(searchResult.total, 1);
  assert.equal(searchResult.matches[0].kind, "summary");
  assert.equal(searchResult.matches[0].dimension, "session");

  const rawSearch = searchWorkspaceHistory(root, { query: "请记录这条 dsh 对话", dimension: "raw" });
  assert.equal(rawSearch.total, 1);
  const readNode = readWorkspaceHistory(root, rawSearch.matches[0].id);
  assert.equal(readNode.kind, "exchange");
  assert.ok(readNode.text.includes("已经记录完成。"));
});
