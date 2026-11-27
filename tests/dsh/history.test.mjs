import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import { DshHistoryWork, registerDshHistoryEvents } from "../../dist/extension/hosts/dsh/history.js";
import { dshHistorySummarizer } from "../../dist/integrations/hosts/dsh/history-summary.js";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";
import { HistoryService } from "../../dist/services/history/history-service.js";
import { HistoryFiles } from "../../dist/storage/history-files.js";

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

test("dsh records root session turns via events and ignores native subagent sessions", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-history-")));
  const data = join(root, "dsh-data");
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await dshHost(data);
  t.after(() => host.close());

  const parent = await host.ctx.agents.create({ cwd: root });
  const child = await host.ctx.agents.create({ cwd: root, origin: "subagent", parentSession: parent.agent.id });
  t.after(() => Promise.allSettled([parent.dispose(), child.dispose()]));

  const work = new DshHistoryWork(host.ctx, root);
  t.after(() => work.close());
  registerDshHistoryEvents(host.ctx, parent.agent, work, () => {});

  emitDshExchange(parent.agent.session, 1, "主会话问题 1", "主会话答复 1");
  emitDshExchange(child.agent.session, 1, "子会话问题", "子会话答复");
  emitDshExchange(parent.agent.session, 2, "主会话问题 2", "主会话答复 2");

  await work.service.refresh();
  assert.equal(work.service.search({ host: "dsh" }).total, 1);
  assert.equal(work.service.search({ query: "主会话答复 1" }).total, 1);
  assert.equal(work.service.search({ query: "主会话答复 2" }).total, 1);
  assert.equal(work.service.search({ query: "子会话答复" }).total, 0);

  const rawFiles = await readdir(join(root, ".pbot/history/raw"));
  assert.equal(rawFiles.length, 1);
});

test("dsh summarizes cross-host raw archives and exposes missing-provider failure cleanly", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-summary-")));
  const data = join(root, "dsh-data");
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await dshHost(data);
  t.after(() => host.close());
  const created = await host.ctx.agents.create({ cwd: root });
  t.after(() => created.dispose());

  for (let i = 0; i < 4; i++) {
    recordHistoryCapture(root, "claude", { kind: "input", sessionId: "claude-1", text: `跨宿主问题 ${i}` });
    recordHistoryCapture(root, "claude", { kind: "answer", sessionId: "claude-1", assistantText: `跨宿主答复 ${i}`, completed: true });
  }

  const files = new HistoryFiles(join(root, ".pbot/history"), "dsh");
  const service = new HistoryService(root, files);
  t.after(() => service.close());
  await service.refresh();
  assert.equal(service.status.pending, 1);

  const failing = dshHistorySummarizer(host.ctx, { provider: "missing-provider", model: "missing-model" }, created.agent.id);
  await assert.rejects(service.organize(failing, new AbortController().signal));
  assert.equal(service.status.pending, 1);
  assert.equal(service.warnings.length, 1);

  await service.organize(async () => "dsh 为 Claude 生成的摘要", new AbortController().signal);
  assert.equal(service.status.pending, 0);
  assert.equal(service.search({ host: "claude", query: "dsh 为 Claude 生成的摘要" }).total, 1);
});
