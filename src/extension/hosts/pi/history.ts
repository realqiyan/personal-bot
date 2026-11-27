import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordHistoryCapture } from "../../../services/history/history-capture.js";
import type { Lifecycle } from "./lifecycle.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block?.type === "text" ? [String(block.text)] : block?.type === "image" ? ["[图片]"] : []).join("\n");
}

/** Capture main-session raw Q&A exchanges into .pbot/history/raw/. Summaries run on explicit trigger. */
export function registerHistoryEvents(pi: ExtensionAPI, lifecycle: Lifecycle) {
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
}
