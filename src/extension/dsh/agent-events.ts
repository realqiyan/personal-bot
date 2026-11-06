import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { agentNotice, teamNotice } from "../../services/agents/agent-notices.js";
import { deliveredDshNotices, pendingDshNotices } from "../../integrations/dsh/notifications.js";
import { flushDshAgent } from "../../integrations/dsh/session.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentOwner, AgentCompletion } from "../../model/agent.js";
import type { TeamInput } from "../../model/team.js";

/** Server-owned scheduling survives browser disconnects; native cancellation pauses dispatch. */
export class DshAgentEvents {
  readonly #dispatching = new Map<string, TeamInput>();
  readonly #signals = new Map<AbortSignal, () => void>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #scan: Promise<void> | undefined;
  #closed = false;
  #pausePending = false;
  #paused = false;
  #error: string | undefined;
  #errorKey: string | undefined;
  #busySince: number | undefined;
  #recovery: "retry" | "repair" | "reload" | undefined;
  #completed: AgentCompletion[] = [];
  #autoWake = false;
  constructor(readonly ctx: Context, readonly agent: Agent, readonly agents: AgentService,
    readonly teams: TeamService, readonly owner: AgentOwner, readonly check: () => void) {}
  get error() { return this.#error; }
  start() {
    this.teams.recover(this.owner);
    this.ctx.on("agent/pre-step", async ({ signal }, next) => {
      if (!this.#signals.has(signal)) {
        const cancel = () => { if (!this.#closed) {
          this.#paused = true; this.#autoWake = false; this.#pausePending = true;
          try { this.pauseTeams(); } catch (error) { this.recordError(error); }
          void this.refresh();
        } };
        this.#signals.set(signal, cancel); signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      }
      await this.refresh(); this.check();
      const decision = await next(); this.check();
      if (decision.kind !== "enter" || this.#paused) return decision;
      const note = this.notice(decision.messages);
      return note ? { ...decision, messages: [...decision.messages, note] } : decision;
    });
    this.ctx.on("session/event", (session, event) => {
      if (session !== this.agent.session || this.#closed) return;
      if (event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.source.kind === "user")) { this.#paused = false; this.#autoWake = true; }
      if (event.type === "user/message" && event.data.source.kind === "pbot-results") this.#autoWake = true;
      if (event.type === "turn/end") {
        for (const [signal, cancel] of this.#signals) signal.removeEventListener("abort", cancel); this.#signals.clear();
        if (event.data.reason.kind === "aborted") {
          this.#paused = true; this.#autoWake = false; this.#pausePending = true;
          try { this.pauseTeams(); } catch (error) { this.recordError(error); }
        }
        void this.refresh();
      }
    });
    this.#timer = setInterval(() => { void this.refresh(); }, 1000); this.#timer.unref();
    this.ctx.effect(() => () => this.close());
  }
  private pauseTeams() {
    if (!this.#pausePending) return;
    try { this.teams.pauseAll(this.owner, "主会话中断"); this.#pausePending = false; this.#dispatching.clear(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "PBOT_CONTROL_BUSY") { this.teams.fail(error); this.#dispatching.clear(); }
      throw error;
    }
  }
  private recordError(error: unknown) {
    if (this.#closed || (error as Error).name === "AbortError") return;
    if ((error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY") {
      this.#busySince ??= Date.now(); if (Date.now() - this.#busySince < 5000) return;
    } else this.#busySince = undefined;
    const message = String(error);
    let recovery: "retry" | "repair" | "reload" = (error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY" ? "retry" : "repair";
    try { this.teams.check(); } catch { recovery = "reload"; }
    if (message !== this.#error || recovery !== this.#recovery) {
      this.ctx.logger.warn("pbot 协作扫描失败：" + message);
      this.#errorKey = "agent-error:" + randomUUID();
    }
    this.#error = message; this.#recovery = recovery;
  }
  private notice(proposed: readonly UserMessage[] = []) {
    const known = new Set([...deliveredDshNotices(this.agent.session.snapshotEvents()),
      ...pendingDshNotices([...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep, ...proposed])]);
    let value: { keys: string[]; content: string } | undefined;
    if (this.#error && this.#errorKey) {
      if (!known.has(this.#errorKey)) value = { keys: [this.#errorKey], content: "# 协作扫描故障\n\n" + this.#error +
        "\n\n先核对控制记录和原生报告；结果未知不是重跑许可。" +
        (this.#recovery === "reload" ? "团队服务已停用；修复文件后还需重载服务端 personal-bot 插件。" :
          this.#recovery === "retry" ? "控制锁持续占用，后台会继续重试；不会自动删除锁或重新提交任务。" : "报告或控制记录读取失败，修复后后台会重试扫描。") +
        (this.#pausePending ? "\n\n团队暂停尚未确认，不能据此开始成员私人任务。" : "") };
    } else {
      value = teamNotice(this.teams.notifications(this.owner, this.agents.list(this.owner)), known) ??
        agentNotice(this.#completed, this.teams.links(), known);
    }
    return value ? createUserMessage({ content: [{ type: "text", text: value.content }],
      source: { kind: "pbot-results", form: "notice", summary: "Personal Bot 协作更新", keys: value.keys } }) : undefined;
  }
  refresh() {
    if (this.#closed || this.#scan) return this.#scan ?? Promise.resolve();
    this.#scan = (async () => {
      try { await this.scan(); } catch (error) { this.recordError(error); }
      if (this.#closed || this.#paused || !this.#autoWake || this.agent.status !== "idle") return;
      try {
        this.check(); const note = this.notice();
        if (note) {
          // A failed admission cannot start an automatic retry loop. Actual receipt or new human input re-arms wakeup.
          this.#autoWake = false; this.agent.followup(note); await flushDshAgent(this.agent);
        }
      } catch (error) { this.recordError(error); }
    })().finally(() => { this.#scan = undefined; });
    return this.#scan;
  }
  private async scan() {
    this.check(); this.pauseTeams(); await this.agents.refresh(this.owner);
    if (this.#closed) return; this.check();
    const completed = await this.agents.completions(this.owner);
    if (this.#closed) return; this.check(); this.#completed = completed;
    try {
      this.pauseTeams();
      for (const input of this.teams.advance(this.owner, this.agents.list(this.owner), completed)) this.#dispatching.set(input.requestId, input);
      for (const [id, input] of this.#dispatching) {
        try { this.agents.enqueueTeam(input, this.owner); this.#dispatching.delete(id); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "PBOT_CONTROL_BUSY") throw error;
          if (code !== "TEAM_INPUT_STALE") throw error;
          this.teams.pauseMember(input.agentId, "安排失效；未自动重发"); this.#dispatching.delete(id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "PBOT_CONTROL_BUSY") { this.teams.fail(error); this.#dispatching.clear(); }
      throw error;
    }
    this.#error = undefined; this.#errorKey = undefined; this.#busySince = undefined; this.#recovery = undefined;
  }
  async close() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    for (const [signal, cancel] of this.#signals) signal.removeEventListener("abort", cancel); this.#signals.clear();
    await this.#scan; this.#dispatching.clear();
  }
}
