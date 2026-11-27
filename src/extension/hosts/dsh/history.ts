import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { recordHistoryCapture } from "../../../services/history/history-capture.js";
import { finalDshAnswer } from "../../../integrations/hosts/dsh/messages.js";

type Question = Extract<SessionEvent, { type: "user/message" }>;

function userMessageText(content: Question["data"]["content"]): string {
  return content.flatMap(block => block.type === "text" ? [block.text] :
    block.type === "image" ? ["[图片 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] :
      block.type === "file" ? ["[附件 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] : []).join("\n");
}

/** Capture root-session raw Q&A exchanges into .pbot/history/raw/. Summaries run on explicit trigger. */
export function registerDshHistoryEvents(ctx: Context, agent: Agent, root: string) {
  let final = false;
  let lastAnswer = "";
  let lastAnswerTime: string | undefined;

  ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    if (event.type === "turn/start") {
      final = false;
      lastAnswer = "";
      lastAnswerTime = undefined;
    }
    if (event.type === "user/message" && event.data.source.kind === "user") {
      const text = userMessageText(event.data.content).trim();
      if (text) {
        try {
          recordHistoryCapture(root, "dsh", {
            kind: "input",
            sessionId: agent.id,
            text,
            timestamp: new Date(event.time).toISOString(),
          });
        } catch { /* Never block a user turn if history persistence fails. */ }
      }
    }
    if (event.type === "assistant/message") {
      const completeText = finalDshAnswer(event).trim();
      final = Boolean(completeText);
      const body = completeText || event.data.message.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      if (body) {
        lastAnswer = body;
        lastAnswerTime = new Date(event.time).toISOString();
      }
    }
    if (event.type === "turn/end") {
      const completed = event.data.reason.kind === "completed" && final;
      if (lastAnswer) {
        try {
          recordHistoryCapture(root, "dsh", {
            kind: "answer",
            sessionId: agent.id,
            assistantText: lastAnswer,
            completed,
            ...(lastAnswerTime ? { timestamp: lastAnswerTime } : {}),
          });
        } catch { /* Never block turn completion if history persistence fails. */ }
      }
      lastAnswer = "";
      lastAnswerTime = undefined;
    }
  });
}
