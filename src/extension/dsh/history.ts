import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { AgentFiles } from "../../storage/agent-files.js";
import { HistoryFiles } from "../../storage/history-files.js";
import { HistoryService } from "../../services/history/history-service.js";
import { DshHistory } from "../../integrations/dsh/history.js";
import { dshHistorySummarizer } from "../../integrations/dsh/history-summary.js";
import { finalDshAnswer } from "../../integrations/dsh/messages.js";

/** One server-owned organizer per workspace, shared by its parent Sessions. */
export class DshHistoryWork {
  readonly service: HistoryService;
  readonly #parents = new Set<Agent>();
  #controller: AbortController | undefined;
  #work: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  constructor(private readonly ctx: Context, root: string) {
    const agents = new AgentFiles(dshHomePath("pbot", "subagents"), "dsh");
    this.service = new HistoryService(root, new HistoryFiles(join(root, ".dsh/pbot/history"), "dsh"),
      new DshHistory(ctx, root, () => agents.list().filter(value => value.workspace === root).map(value => value.agentId)),
      undefined, new HistoryFiles(join(root, ".pi/pbot/history")));
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
      await this.service.refresh({ host: "dsh", sessionId }, signal);
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
  ctx.effect(() => work.attach(agent));
  ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    if (event.type === "turn/start") { normal = false; final = false; }
    if (event.type === "assistant/message") final = Boolean(finalDshAnswer(event).trim());
    if (event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.source.kind === "user")) { normal = false; work.cancel(); }
    if (event.type === "turn/end") normal = event.data.reason.kind === "completed" && final;
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
