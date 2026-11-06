import type { Context } from "@deepseek-ai/cordis";
import type { Agent, InboxTarget } from "@deepseek-ai/dsh-agent";
import { foldConsumedWork } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type UserMessage, type FileBlock, type ImageBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { AgentRun } from "../../services/agents/agent-run.js";
import type { TeamService } from "../../services/agents/team-service.js";
import { AgentFiles, launch } from "../../storage/agent-files.js";
import type { AgentDescriptor } from "../../model/agent.js";
import type { TeamLink } from "../../model/team.js";
import { requireThat } from "../../common/validation.js";
import { dshInput, dshHumanInput } from "../../integrations/dsh/input.js";
import { requestSource, finalDshAnswer } from "../../integrations/dsh/messages.js";
import { flushDshAgent } from "../../integrations/dsh/session.js";
import { createTeamContext, teamBrief } from "../../integrations/team-context.js";

/** One expert's native event adapter. AgentRun and TeamService own durable business state. */
export class DshAgentRuntime {
  readonly execution: AgentRun;
  readonly #lifetime = new AbortController();
  readonly #inbox: Record<InboxTarget, UserMessage[]> = { "next-turn": [], "next-step": [] };
  readonly #seen = new Map<string, Set<number>>();
  #events = Promise.resolve();
  #turnEvents: SessionEvent[] = [];
  #answer = "";
  #hasAnswer = false;
  #activeTeam: TeamLink | undefined;
  #pendingPause: string | undefined;
  #pump: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopping: Promise<void> | undefined;
  #closing = false;
  #failure: unknown;
  #ready = false;
  #teamTool = false;
  constructor(readonly ctx: Context, readonly agent: Agent, readonly d: AgentDescriptor, readonly generation: string,
    readonly files: AgentFiles, readonly teams: TeamService, readonly owner: { check(): void; release(): Promise<void> }) {
    this.execution = new AgentRun(files, d.agentId, generation);
  }
  check = () => {
    this.#lifetime.signal.throwIfAborted(); this.owner.check(); this.files.check();
    const run = this.files.read(this.d.agentId, "launch.json", launch);
    requireThat(run.generation === this.generation && !run.stop, "专家已停止或启动代次变化。");
  };
  actor = () => ({ kind: "member" as const, agentId: this.d.agentId, generation: this.generation,
    ...(this.#activeTeam && this.execution.current?.source === "parent" ? { requestId: this.#activeTeam.request.requestId } : {}) });
  private current() { return this.files.read(this.d.agentId, "launch.json", launch).generation === this.generation; }
  private pause(reason: string) {
    this.#pendingPause = reason;
    try { this.teams.pauseMember(this.d.agentId, reason); this.#pendingPause = undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "PBOT_CONTROL_BUSY") throw error; }
  }
  private enqueue(work: () => void | Promise<void>) {
    this.#events = this.#events.then(work).catch(error => this.fail(error));
  }
  private fail(error: unknown) {
    if (this.#failure) return;
    this.#failure = error; this.#lifetime.abort();
    try {
      if (this.current()) {
        this.teams.files.setReady(this.d.agentId, this.generation, false);
        this.execution.save({ state: "error", activity: "控制失败", error: String(error) });
        this.pause("专家控制失败");
      }
    } catch (failure) { this.ctx.logger.error("pbot 专家状态保存失败", failure); }
    void this.owner.release().catch(failure => this.ctx.logger.error("pbot 专家释放失败", failure));
  }
  initialize(teamTool: boolean) {
    this.check(); this.#teamTool = teamTool;
    this.teams.files.setReady(this.d.agentId, this.generation, false);
    this.pause("专家载入：旧批次不自动恢复");
    this.execution.recover();
    for (const event of this.agent.session.snapshotEvents()) if (event.type === "user/message" && event.data.source.kind === "pbot-team-context") {
      const { teamId, seqs } = event.data.source, seen = this.#seen.get(teamId) ?? new Set<number>();
      for (const seq of seqs) seen.add(seq); this.#seen.set(teamId, seen);
    }
    this.ctx.on("session/event", (session, event) => {
      if (session === this.agent.session) this.enqueue(() => this.event(event));
    });
    this.ctx.on("agent/status", ({ agent, status }) => {
      if (agent !== this.agent) return;
      this.enqueue(() => {
        if (!this.current() || this.#closing || this.#failure) return;
        this.execution.save({ state: status === "idle" ? "idle" : "busy", activity: status === "idle" ? "空闲" : "执行" });
      });
    });
    this.ctx.on("agent/pre-step", async (_payload, next) => {
      await this.#events; this.check();
      if (this.#activeTeam && !this.humanPending() && this.execution.current?.source === "parent" && Date.now() >= this.#activeTeam.run.deadlineAt) {
        this.pause("已到期限"); this.agent.cancel({ kind: "hook", reason: "团队请求已到期限" });
        return { kind: "reject" };
      }
      const decision = await next();
      this.check();
      if (decision.kind !== "enter" || !this.#activeTeam || this.execution.current?.source !== "parent" || this.humanPending() ||
        decision.messages.some(message => message.source.kind === "user")) return decision;
      const link = this.teams.links().get(this.#activeTeam.request.requestId);
      requireThat(link, "团队关联不可读取。");
      const seen = this.#seen.get(link.team.teamId) ?? new Set<number>();
      const context = createTeamContext(link, seen);
      if (!context) return decision;
      return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: "text", text: context.content }],
        source: { kind: "pbot-team-context", form: "relay", teamId: link.team.teamId, seqs: context.seqs } })] };
    });
    this.ctx.systemPrompt.section({ name: "pbot:team", order: 600, interpolate: false,
      text: () => this.#activeTeam && !this.humanPending() && this.execution.current?.source === "parent" ? teamBrief(this.#activeTeam) : "" });
    this.execution.save({ state: "idle", activity: "空闲" });
    this.ctx.effect(() => () => this.stop());
  }
  /** Called only after native Agent creation has resolved, never from setup. */
  start() {
    this.check();
    this.#timer = setInterval(() => { void this.pump(); }, 250); this.#timer.unref();
    void this.pump();
  }
  async interact(text: string, delivery: "steer" | "followUp" = "steer", files: readonly string[] = [],
    attachments: readonly (ImageBlock | FileBlock)[] = [], caller?: AbortSignal) {
    this.check(); requireThat((text.trim().length > 0 || files.length || attachments.length) && text.length <= 24000, "请输入消息或附加文件；消息最多 24000 字符。");
    const signal = caller ? AbortSignal.any([caller, this.#lifetime.signal]) : this.#lifetime.signal;
    const message = await dshHumanInput(this.ctx, this.d.cwd, text, files, attachments, signal);
    this.check(); signal.throwIfAborted();
    this.teams.pauseMember(this.d.agentId, "成员由人工接管");
    if (delivery === "followUp") this.agent.followup(message); else this.agent.steer(message);
    // Native inbox admission transfers ownership to the expert, independently of the UI request.
    await flushDshAgent(this.agent);
    return { status: "queued" as const, messageId: message.id };
  }
  private async event(event: SessionEvent) {
    if (!this.current()) return;
    if (event.type === "turn/start") {
      this.#turnEvents = []; this.#answer = ""; this.#hasAnswer = false;
      this.execution.begin();
    }
    if (this.execution.current) this.#turnEvents.push(event);
    if (event.type === "agent/inbox/spliced") {
      const change = event.data;
      const removed = this.#inbox[change.target].splice(change.start, change.removedCount ?? 0, ...change.inserted);
      if (change.inserted.some(message => message.source.kind === "user")) this.pause("成员由人工接管");
      for (const message of removed) {
        if (message.source.kind === "user" && change.outcome !== "canceled") this.execution.enterHuman();
        const source = requestSource(message, this.generation);
        if (!source) continue;
        if (change.outcome === "canceled") {
          this.execution.cancelQueued(source.requestId);
          if (this.#activeTeam?.request.requestId === source.requestId && !this.execution.current?.requestIds.includes(source.requestId)) this.#activeTeam = undefined;
        } else this.execution.enter(source.requestId);
      }
    }
    if (event.type === "user/message") {
      const source = requestSource(event.data, this.generation);
      if (source) this.execution.consume(source.requestId);
      if (event.data.source.kind === "user") this.execution.humanInput();
      if (event.data.source.kind === "pbot-team-context") {
        const { teamId, seqs } = event.data.source, seen = this.#seen.get(teamId) ?? new Set<number>();
        for (const seq of seqs) seen.add(seq); this.#seen.set(teamId, seen);
      }
    }
    if (event.type === "assistant/message") {
      this.#answer = finalDshAnswer(event); this.#hasAnswer = true;
    }
    if (event.type === "turn/end") {
      const accounted = foldConsumedWork(this.#turnEvents).end?.seq === event.seq;
      await flushDshAgent(this.agent);
      const reason = event.data.reason;
      this.execution.finish({
        state: reason.kind === "aborted" ? "cancelled" : reason.kind === "interrupted" || reason.kind === "forked" ? "interrupted"
          : reason.kind === "completed" && accounted ? "completed" : "failed",
        position: this.#hasAnswer ? "dsh:" + event.seq : null,
        answer: this.#answer,
        ...(reason.kind === "error" ? { error: reason.error.message } : !["completed", "aborted"].includes(reason.kind) ? { error: reason.kind } : {}),
      });
      this.#activeTeam = undefined; this.#turnEvents = [];
    }
  }
  private humanPending() { return [...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep].some(message => message.source.kind === "user"); }
  private pump() {
    if (this.#pump || this.#closing) return this.#pump ?? Promise.resolve();
    this.#pump = this.deliver().catch(error => {
      if ((error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY" || (this.#closing && this.#lifetime.signal.aborted)) return;
      this.fail(error);
    }).finally(() => { this.#pump = undefined; });
    return this.#pump;
  }
  private async deliver() {
    const run = this.files.read(this.d.agentId, "launch.json", launch);
    if (run.generation !== this.generation || run.stop) { void this.owner.release().catch(error => this.fail(error)); return; }
    await this.#events; this.check();
    if (this.#pendingPause) { this.pause(this.#pendingPause); if (this.#pendingPause) return; }
    const capable = this.#teamTool && !!this.ctx.tools.get("pbot_team_message", this.agent);
    if (capable !== this.#ready) {
      this.teams.files.setReady(this.d.agentId, this.generation, capable); this.#ready = capable;
      if (!capable) this.pause("成员团队工具已停用");
    }
    if (this.#activeTeam) {
      if (Date.now() >= this.#activeTeam.run.deadlineAt) {
        this.pause("已到期限");
        if (!this.humanPending() && !this.execution.interactive && this.execution.current?.source !== "mixed" && this.execution.current?.source !== "interactive") this.agent.cancel({ kind: "hook", reason: "团队请求已到期限" });
      }
      return;
    }
    const links = this.teams.links();
    const idle = () => this.agent.status === "idle" && !this.agent.inbox.nextTurn.length && !this.agent.inbox.nextStep.length && !this.execution.current && !this.execution.pending && !this.execution.interactive;
    for (const request of this.files.messages(this.d.agentId)) {
      if (request.generation !== this.generation || this.execution.accepted(request.requestId)) continue;
      const link = links.get(request.requestId);
      if (link && (link.team.closed || link.run.state !== "running" || link.run.deadlineAt <= Date.now())) continue;
      if (link && !idle()) break;
      const message = await dshInput(this.ctx, this.d, request, this.#lifetime.signal);
      this.check();
      const submit = async () => {
        this.check();
        const accept = () => this.execution.claim(request.requestId);
        if (link) {
          if (!idle()) return;
          this.#activeTeam = this.teams.claim(this.d.agentId, this.generation, request.requestId, accept);
          if (!this.#activeTeam) return;
        } else accept();
        if (request.delivery === "followUp") this.agent.followup(message); else this.agent.steer(message);
        await flushDshAgent(this.agent);
      };
      if (link) {
        // Public status stays idle during native maintenance. Its idle admission is authoritative.
        let entered = false;
        try { await this.agent.runMaintenance(async signal => { entered = true; signal.throwIfAborted(); await submit(); }); }
        catch (error) { if (entered) throw error; this.check(); }
      } else await submit();
      break;
    }
  }
  stop() {
    if (this.#stopping) return this.#stopping;
    this.#closing = true; this.#lifetime.abort();
    if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    this.#stopping = (async () => {
      try {
        if (this.current()) {
          this.files.control(() => {
            const run = this.files.read(this.d.agentId, "launch.json", launch);
            if (run.generation === this.generation && !run.stop) { run.stop = true; this.files.write(this.d.agentId, "launch.json", run, launch); }
          });
          this.teams.files.setReady(this.d.agentId, this.generation, false); this.#ready = false;
          this.pause("专家停止");
          if (!this.#failure) this.execution.save({ state: "stopping", activity: "停止" });
        }
      } finally { this.agent.cancel({ kind: "disposed" }); }
      await this.agent.whenIdle(); await this.#pump; await this.#events;
      if (this.current() && !this.#failure) this.execution.save({ state: "stopped", activity: "已停止" });
    })();
    return this.#stopping;
  }
}
