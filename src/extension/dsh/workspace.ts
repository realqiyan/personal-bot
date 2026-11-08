import { realpath } from "node:fs/promises";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentOwner } from "../../model/agent.js";
import { DshAgents } from "../../integrations/dsh/dsh-agents.js";
import { dshResources, dshExpertTools } from "../../integrations/dsh/resources.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { TeamService } from "../../services/agents/team-service.js";
import { registerDshAgentTool } from "../../tools/agents/dsh-tool.js";
import { registerDshTeamTool, registerDshTeamMessageTool } from "../../tools/teams/dsh-tool.js";
import { DshAgentRuntime } from "./agent-runtime.js";
import { DshAgentEvents } from "./agent-events.js";
import { registerDshFileEvents } from "./files.js";
import { DshHistoryWork, registerDshHistoryEvents } from "./history.js";
import type { HistoryService } from "../../services/history/history-service.js";
import { registerDshHistoryTool } from "../../tools/history/dsh-tool.js";
import { activatePython } from "../../integrations/python-activation.js";
import { PythonEnvironmentService } from "../../services/workspace/python-environment-service.js";
import { requireThat } from "../../common/validation.js";
import { registerDshSkills } from "../../integrations/dsh/skills.js";
import { readWorkspaceConfig, workspaceDisabledMessage } from "../../services/workspace/workspace-config.js";
import type { WorkspaceConfiguration } from "../../model/workspace-config.js";
import { initializeWorkspace } from "../../services/workspace/workspace-preparation.js";

export const dshDependencies = ["agents", "sessions", "sessionPersistence", "sessionQuery", "llm", "tools", "systemPrompt", "skills", "fs", "attachments", "workingDirectory", "approval"];

export class DshWorkspace {
  readonly lifetime = new AbortController();
  readonly host: DshAgents;
  readonly agents: AgentService;
  readonly teams: TeamService;
  readonly history: HistoryService;
  readonly owner: AgentOwner;
  readonly #experts = new Map<string, DshAgentRuntime>();
  #scope: { dispose(): Promise<void> } | undefined;
  #events: DshAgentEvents | undefined;
  #closing: Promise<void> | undefined;
  constructor(readonly ctx: Context, readonly root: string, readonly agent: Agent,
    readonly python: PythonEnvironmentService, readonly component: AbortSignal,
    private readonly historyWork: DshHistoryWork, private readonly releaseHistory: () => Promise<void>) {
    this.history = historyWork.service;
    this.owner = { sessionId: agent.id, leaf: null, branch: [] };
    this.host = new DshAgents(ctx, agent, {
      setup: (d, _directory, generation) => async (agentCtx, child) => {
        for (const key of ["noExtensions", "noPromptTemplates", "noContextFiles"] as const) requireThat(d.options[key] === undefined, "dsh 不支持宿主选项：" + key);
        await agentCtx.plugin({ name: "pbot-expert", inject: dshDependencies, apply: async scope => {
          const runtime = new DshAgentRuntime(scope, child, d, generation, this.agents.files, this.teams,
            { check: this.check, release: () => this.host.release(d.agentId, generation) });
          this.#experts.set(d.agentId, runtime);
          scope.effect(() => () => { if (this.#experts.get(d.agentId) === runtime) this.#experts.delete(d.agentId); });
          registerDshSkills(scope, child);
          await dshResources(scope, child, root, "general-purpose", () => python.status, runtime.check);
          const teamTool = dshExpertTools(scope, child, d.options);
          if (teamTool) registerDshTeamMessageTool(scope, child, this.teams, runtime.actor, runtime.check);
          registerDshFileEvents(scope, child, root, true, runtime.check);
          runtime.initialize(teamTool);
        } });
        return { commit: this.check };
      },
      ready: (child, generation) => {
        const runtime = this.#experts.get(child.id);
        requireThat(runtime?.generation === generation, "专家执行组件未就绪。"); runtime.start();
      },
      stopping: async (child, generation) => { const runtime = this.#experts.get(child.id); if (runtime?.generation === generation) await runtime.stop(); },
    }, this.lifetime.signal);
    this.agents = new AgentService(root, dshHomePath("pbot", "subagents"), this.host);
    this.teams = new TeamService(root, this.agents.files, this.agents.teamFiles);
  }
  check = () => { this.component.throwIfAborted(); this.lifetime.signal.throwIfAborted(); };
  get controlError() { return this.#events?.error; }
  async open() {
    this.check();
    this.#scope = await this.agent.ctx.plugin({ name: "pbot-coordinator", inject: dshDependencies, apply: async ctx => {
      registerDshSkills(ctx, this.agent);
      await dshResources(ctx, this.agent, this.root, "coordinator", () => this.python.status, this.check);
      registerDshFileEvents(ctx, this.agent, this.root, false, this.check);
      registerDshAgentTool(ctx, this.agent, this.agents, this.owner, this.check);
      registerDshTeamTool(ctx, this.agent, this.teams, this.agents, this.owner, this.check);
      registerDshTeamMessageTool(ctx, this.agent, this.teams, () => ({ kind: "coordinator", owner: this.owner }), this.check);
      registerDshHistoryTool(ctx, this.agent, this.history, this.lifetime.signal, this.check);
      registerDshHistoryEvents(ctx, this.agent, this.historyWork, this.check);
      this.#events = new DshAgentEvents(ctx, this.agent, this.agents, this.teams, this.owner, this.check);
      this.#events.start();
    } });
    this.check();
  }
  expert(id: string) {
    this.check(); const view = this.agents.status(id, this.owner), runtime = this.#experts.get(id);
    requireThat(view.owned, "专家不属于当前父会话。");
    requireThat(view.alive, "专家已停止；需要明确恢复后才能对话。");
    requireThat(view.state !== "starting", "专家尚未就绪，请等待启动或恢复完成。");
    requireThat(runtime?.generation === view.generation, "原生专家由其他执行实例持有；当前组件不能接管对话。");
    return runtime;
  }
  close() {
    if (this.#closing) return this.#closing;
    this.lifetime.abort();
    this.#closing = (async () => {
      const errors: unknown[] = [];
      try { await this.#events?.close(); } catch (error) { errors.push(error); }
      try { this.teams.pauseAll(this.owner, "父会话或执行组件关闭"); } catch (error) { errors.push(error); }
      try { await this.agents.close(this.owner); } catch (error) { errors.push(error); }
      try { await this.host.close(); } catch (error) { errors.push(error); }
      this.teams.dispose();
      try { await this.#scope?.dispose(); } catch (error) { errors.push(error); }
      try { await this.releaseHistory(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "dsh 工作区关闭失败；请核对执行资源和控制记录。");
    })();
    return this.#closing;
  }
}

/** The execution component owns Python; closing one Session must not undo its activation. */
export class DshWorkspaces {
  readonly python = new PythonEnvironmentService(process.cwd());
  readonly #parents = new Map<Agent, Promise<DshWorkspace | undefined>>();
  readonly #initializing = new Map<string, Promise<void>>();
  readonly #configurations = new Map<Agent, { root: string; configuration: WorkspaceConfiguration }>();
  readonly #parentEffects = new Map<Agent, () => Promise<void>>();
  readonly #histories = new Map<string, { work: DshHistoryWork; users: number }>();
  readonly #lifetime = new AbortController();
  #restorePython: (() => void) | undefined;
  #preparing: Promise<{ directory: string; python: string }> | undefined;
  #closing: Promise<void> | undefined;
  constructor(readonly ctx: Context) {}

  private async history(root: string): Promise<{ work: DshHistoryWork; release(): Promise<void> }> {
    this.#lifetime.signal.throwIfAborted();
    let entry = this.#histories.get(root);
    if (entry && entry.users === 0) {
      await entry.work.close(); this.#lifetime.signal.throwIfAborted();
      if (this.#histories.get(root) === entry) this.#histories.delete(root);
      return this.history(root);
    }
    if (!entry) { entry = { work: new DshHistoryWork(this.ctx, root), users: 0 }; this.#histories.set(root, entry); }
    const owned = entry; owned.users++;
    let released = false;
    return { work: owned.work, release: async () => {
      if (released) return; released = true;
      if (--owned.users === 0) {
        try { await owned.work.close(); } finally { if (this.#histories.get(root) === owned) this.#histories.delete(root); }
      }
    } };
  }

  async open(agent: Agent) {
    this.#lifetime.signal.throwIfAborted();
    requireThat(this.ctx.agents.roots().includes(agent) && agent.session.header.origin !== "subagent", "专家不拥有协调者管理入口。");
    const current = this.#parents.get(agent);
    if (current) return current;
    const opening = (async () => {
      const root = await realpath(agent.session.header.cwd ?? process.cwd());
      this.#lifetime.signal.throwIfAborted();
      const configuration = await readWorkspaceConfig(root);
      this.#lifetime.signal.throwIfAborted();
      this.#configurations.set(agent, { root, configuration });
      if (!configuration.enabled) {
        if (configuration.error) this.ctx.logger.warn(configuration.error);
        const dispose = agent.ctx.effect(() => () => {
          this.#parents.delete(agent); this.#configurations.delete(agent); this.#parentEffects.delete(agent);
        });
        this.#parentEffects.set(agent, dispose);
        return undefined;
      }
      const history = await this.history(root);
      let workspace: DshWorkspace | undefined;
      try {
        workspace = new DshWorkspace(this.ctx, root, agent, this.python, this.#lifetime.signal, history.work, history.release);
        const owned = workspace;
        const dispose = agent.ctx.effect(() => async () => {
          this.#parents.delete(agent); this.#configurations.delete(agent); this.#parentEffects.delete(agent); await owned.close();
        });
        this.#parentEffects.set(agent, dispose);
        await workspace.open(); this.#lifetime.signal.throwIfAborted();
        void this.preparePython().catch(error => this.ctx.logger.warn(String(error)));
        return workspace;
      } catch (error) {
        try {
          const dispose = this.#parentEffects.get(agent);
          if (dispose) await dispose(); else if (workspace) await workspace.close(); else await history.release();
        } catch (cleanup) { throw new AggregateError([error, cleanup], "dsh 工作区装配与清理均未完成。"); }
        throw error;
      }
    })();
    this.#parents.set(agent, opening);
    try { return await opening; }
    catch (error) { this.#parents.delete(agent); throw error; }
  }

  async get(agent: Agent) {
    this.#lifetime.signal.throwIfAborted();
    requireThat(this.ctx.agents.get(agent.id) === agent, "父会话已关闭。");
    const workspace = await this.open(agent);
    const configuration = this.#configurations.get(agent)?.configuration;
    requireThat(workspace, configuration ? workspaceDisabledMessage(configuration) : "pbot 工作区实例不可用。");
    workspace.check();
    return workspace;
  }

  async configuration(agent: Agent) {
    this.#lifetime.signal.throwIfAborted();
    requireThat(this.ctx.agents.get(agent.id) === agent, "父会话已关闭。");
    await this.open(agent);
    this.#lifetime.signal.throwIfAborted();
    const current = this.#configurations.get(agent);
    requireThat(current && this.ctx.agents.get(agent.id) === agent, "父会话已关闭。");
    return current;
  }

  async initialize(agent: Agent): Promise<DshWorkspace> {
    const { root } = await this.configuration(agent);
    let pending = this.#initializing.get(root);
    if (!pending) {
      pending = (async () => {
        await initializeWorkspace(root);
        this.#lifetime.signal.throwIfAborted();
        const configuration = await readWorkspaceConfig(root);
        for (const [parent, current] of [...this.#configurations]) {
          if (current.root !== root || this.ctx.agents.get(parent.id) !== parent) continue;
          const workspace = await this.#parents.get(parent);
          if (workspace) { this.#configurations.set(parent, { root, configuration }); continue; }
          await this.#parentEffects.get(parent)?.();
          await this.open(parent);
        }
      })();
      this.#initializing.set(root, pending);
    }
    try { await pending; }
    finally { if (this.#initializing.get(root) === pending) this.#initializing.delete(root); }
    return this.get(agent);
  }

  preparePython() {
    this.#lifetime.signal.throwIfAborted();
    if (this.#preparing) return this.#preparing;
    this.#preparing = (async () => {
      const result = await this.python.setup(this.#lifetime.signal);
      this.#lifetime.signal.throwIfAborted();
      if (!this.#restorePython) this.#restorePython = activatePython(result.directory);
      return result;
    })().finally(() => { this.#preparing = undefined; });
    return this.#preparing;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#lifetime.abort();
    this.#closing = (async () => {
      try {
        await Promise.allSettled(this.#initializing.values());
        const opened = await Promise.allSettled(this.#parents.values());
        const closed = await Promise.allSettled(opened.flatMap(value => value.status === "fulfilled" && value.value ? [value.value.close()] : []));
        const effects = await Promise.allSettled([...this.#parentEffects.values()].map(dispose => dispose()));
        const histories = await Promise.allSettled([...this.#histories.values()].map(value => value.work.close()));
        await this.python.close();
        const errors = [...new Set([...closed, ...effects, ...histories].flatMap(value => value.status === "rejected" ? [value.reason] : []))];
        if (errors.length) throw new AggregateError(errors, "部分 dsh 工作区未能完成关闭。");
      } finally { this.#parents.clear(); this.#configurations.clear(); this.#parentEffects.clear(); this.#histories.clear(); this.#restorePython?.(); this.#restorePython = undefined; }
    })();
    return this.#closing;
  }
}
