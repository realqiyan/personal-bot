import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { HistoryFiles } from "../../../storage/history-files.js";
import { recordHistoryCapture } from "../../../services/history/history-capture.js";
import { HistoryService } from "../../../services/history/history-service.js";
import { dshHistorySummarizer } from "../../../integrations/hosts/dsh/history-summary.js";
import { finalDshAnswer } from "../../../integrations/hosts/dsh/messages.js";

type Question = Extract<SessionEvent, { type: "user/message" }>;

function userMessageText(content: Question["data"]["content"]): string {
  return content.flatMap(block => block.type === "text" ? [block.text] :
    block.type === "image" ? ["[图片 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] :
      block.type === "file" ? ["[附件 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] : []).join("\n");
}

/** One server-owned organizer per workspace, shared by its parent Sessions. */
export class DshHistoryWork {
  readonly service: HistoryService;
  readonly #parents = new Set<Agent>();
  #controller: AbortController | undefined;
  #work: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(private readonly ctx: Context, readonly root: string) {
    this.service = new HistoryService(root, new HistoryFiles(join(root, ".pbot/history"), "dsh"));
  }

  attach(agent: Agent) { this.#parents.add(agent); return () => { this.#parents.delete(agent); }; }
  cancel() { this.#controller?.abort(); }
  schedule(agent: Agent) {
    if (this.#closing || [...this.#parents].some(parent => parent.status !== "idle" || parent.inbox.nextTurn.length || parent.inbox.nextStep.length)) return;
    this.cancel();
    const controller = new AbortController(), selection = agent.model.current(), sessionId = agent.id;
    this.#controller = controller;
    const signal = controller.signal;
    const work = (this.#work ?? Promise.resolve()).catch(() => {}).then(async () => {
      signal.throwIfAborted();
      await this.service.refresh(signal);
      signal.throwIfAborted();
      await this.service.organize(dshHistorySummarizer(this.ctx, selection, sessionId), signal);
    }).catch(error => { if (!signal.aborted) this.ctx.logger.warn("pbot 历史整理未完成：" + String(error)); });
    this.#work = work;
    void work.finally(() => { if (this.#work === work) { this.#work = undefined; this.#controller = undefined; } });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.cancel();
    this.#closing = (async () => { await this.#work; await this.service.close(); this.#parents.clear(); })();
    return this.#closing;
  }
}

export function registerDshHistoryEvents(ctx: Context, agent: Agent, work: DshHistoryWork, check: () => void) {
  let normal = false, final = false;
  let lastAnswer = "", lastAnswerTime: string | undefined;
  ctx.effect(() => work.attach(agent));
  ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    if (event.type === "turn/start") { normal = false; final = false; lastAnswer = ""; lastAnswerTime = undefined; }
    if (event.type === "user/message" && event.data.source.kind === "user") {
      const text = userMessageText(event.data.content).trim();
      if (text) {
        try {
          recordHistoryCapture(work.root, "dsh", {
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
    if (event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.source.kind === "user")) { normal = false; work.cancel(); }
    if (event.type === "turn/end") {
      normal = event.data.reason.kind === "completed" && final;
      if (lastAnswer) {
        try {
          recordHistoryCapture(work.root, "dsh", {
            kind: "answer",
            sessionId: agent.id,
            assistantText: lastAnswer,
            completed: normal,
            ...(lastAnswerTime ? { timestamp: lastAnswerTime } : {}),
          });
        } catch { /* Never block turn completion if history persistence fails. */ }
      }
      lastAnswer = "";
      lastAnswerTime = undefined;
    }
  });
  ctx.on("agent/pre-step", async (_payload, next) => { work.cancel(); check(); return next(); });
  ctx.on("agent/status", ({ agent: changed, status }) => {
    if (changed !== agent || status !== "idle" || !normal) return;
    normal = false;
    if (!agent.inbox.nextTurn.length && !agent.inbox.nextStep.length) {
      try { check(); } catch (error) { if ((error as Error).name === "AbortError") return; throw error; }
      work.schedule(agent);
    }
  });
}
