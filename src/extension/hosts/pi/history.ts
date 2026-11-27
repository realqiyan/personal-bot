import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historySummarizer } from "../../../integrations/hosts/pi/history-summary.js";
import { recordHistoryCapture } from "../../../services/history/history-capture.js";
import type { Lifecycle } from "./lifecycle.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block?.type === "text" ? [String(block.text)] : block?.type === "image" ? ["[图片]"] : []).join("\n");
}

export function registerHistoryEvents(pi: ExtensionAPI, lifecycle: Lifecycle) {
  pi.on("session_start", async (_event, ctx) => {
    const instance = lifecycle.active;
    if (!instance || !instance.features.history) return;
    try { await instance.history.refresh(instance.signal()); }
    catch (error) { ctx.ui.notify("历史索引：" + String(error), "warning"); }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance || !instance.features.history || event.messageType !== "user") return;
    const text = event.prompt.trim();
    if (!text) return;
    try {
      recordHistoryCapture(instance.root, "pi", {
        kind: "input",
        sessionId: ctx.sessionManager.getSessionId(),
        text,
      });
    } catch { /* Never block a user turn if history persistence fails. */ }
  });

  pi.on("agent_end", (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance || !instance.features.history) return;
    const assistant = [...event.messages].reverse().find(message => message.role === "assistant");
    if (!assistant || !("content" in assistant)) return;
    const text = messageText(assistant.content).trim();
    if (!text) return;
    const completed = "stopReason" in assistant && assistant.stopReason === "stop" &&
      !(Array.isArray(assistant.content) && assistant.content.some(block => block.type === "toolCall"));
    try {
      recordHistoryCapture(instance.root, "pi", {
        kind: "answer",
        sessionId: ctx.sessionManager.getSessionId(),
        assistantText: text,
        completed,
      });
    } catch { /* Never block turn completion if history persistence fails. */ }
  });

  pi.on("agent_settled", (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance || !instance.features.history || event.aborted) return;
    const signal = instance.signal();
    void (async () => {
      await instance.history.refresh(signal);
      signal.throwIfAborted();
      const summarize = await historySummarizer(ctx);
      ctx.ui.setStatus("pbot-history", "历史整理中");
      await instance.history.organize(summarize, signal);
    })().catch(error => {
      if (!signal.aborted) ctx.ui.notify("历史摘要暂未完成，下次交互结束后重试：" + String(error), "warning");
    }).finally(() => { if (lifecycle.active === instance) ctx.ui.setStatus("pbot-history", undefined); });
  });
}
