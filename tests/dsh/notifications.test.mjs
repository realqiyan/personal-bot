import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAssistantMessage, createUserMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { dshHost } from "../helpers/dsh-host.mjs";
import { flushDshAgent } from "../../dist/integrations/dsh/session.js";
import { deliveredDshNotices, pendingDshNotices } from "../../dist/integrations/dsh/notifications.js";

test("native notice receipts require admitted context or a committed successful read transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbot-dsh-notices-")), host = await dshHost(root);
  try {
    const handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root } });
    const agent = handle.agent, session = agent.session;
    const notice = () => createUserMessage({ content: [{ type: "text", text: "Recorded notice" }],
      source: { kind: "pbot-results", form: "notice", summary: "Results", keys: ["notice"] } });
    agent.inbox.append("next-step", notice());
    assert.deepEqual(pendingDshNotices(agent.inbox.nextStep), ["notice"]);
    assert.deepEqual([...deliveredDshNotices(session.snapshotEvents())], []);
    agent.inbox.clear();
    // These are native history fixtures, not model responses or provider substitutes.
    session.append("turn/start", { turn: 1 });
    let step = 0;
    const open = (id, name, args) => {
      step++;
      session.append("step/start", { turn: 1, step });
      if (step === 1) session.append("user/message", notice(), { surfaceOp: "append" });
      session.append("assistant/message", { turn: 1, step,
        message: createAssistantMessage({ content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }],
          source: { provider: "deepseek-official", model: "deepseek-flash" } }), stream: [] }, { surfaceOp: "append" });
      session.append("tool/call", { turn: 1, step, callId: id, name, arguments: JSON.stringify(args) });
    };
    const close = (id, key, isError = false) => {
      session.append("tool/result", { turn: 1, step,
        message: createToolResultMessage({ callId: id, content: [{ type: "text", text: "Recorded result" }], isError }),
        meta: { pbotAgentReadKeys: [key] } }, { surfaceOp: "append" });
      session.append("step/end", { turn: 1, step });
    };
    open("status", "pbot_agent", { action: "status" }); close("status", "status-is-not-read");
    open("failed", "pbot_agent", { action: "read" }); close("failed", "failed-is-not-read", true);
    open("direct", "pbot_agent", { action: "read" }); close("direct", "direct");
    for (const failed of [true, false]) {
      const id = "outer-" + step;
      open(id, "run_code", { code: "/* stored invocation */" });
      const data = { rootCallId: id, parentCallId: id, subCallId: id + ":ptc:1", name: "pbot_agent", arguments: { action: "read" } };
      session.append("tool/ptc-dispatch-start", data);
      session.append("tool/ptc-dispatch", { ...data, isError: false, content: [{ type: "text", text: "Recorded inner result" }],
        meta: { pbotAgentReadKeys: [failed ? "uncommitted-inner" : "nested"] } });
      close(id, "transport-meta-is-not-read", failed);
    }
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await flushDshAgent(agent); await handle.dispose();
    const stored = await host.ctx.sessionQuery.readSession(agent.id);
    assert.deepEqual([...deliveredDshNotices(stored.events)].sort(), ["direct", "nested", "notice"]);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
