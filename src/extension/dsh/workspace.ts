import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { rootAgents } from "../../integrations/dsh/root-agents.js";
import { dshResources } from "../../integrations/dsh/resources.js";
import { registerDshFileEvents } from "./files.js";
import { DshHistoryWork, registerDshHistoryEvents } from "./history.js";
import type { HistoryService } from "../../services/history/history-service.js";
import { registerDshHistoryTool } from "../../tools/history/dsh-tool.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { toDshMcpConfig } from "../../integrations/dsh/mcp.js";
import { registerDshSkills } from "../../integrations/dsh/skills.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "../../services/workspace/workspace-mcp.js";
import type { ResolvedWorkspaceFeatures, WorkspaceConfiguration } from "../../model/workspace-config.js";
import { initializeWorkspace } from "../../services/workspace/workspace-preparation.js";
import { McpWorkerRuntime, defaultWorkerDirectory } from "../mcp-workers.js";

export const dshDependencies = ["agents", "sessions", "sessionPersistence", "sessionQuery", "llm", "tools", "systemPrompt", "skills", "fs", "workingDirectory", "approval"];

export class DshWorkspace {
  readonly lifetime = new AbortController();
  readonly history: HistoryService;
  readonly workers: McpWorkerRuntime;
  #scope: { dispose(): Promise<void> } | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    readonly ctx: Context,
    readonly root: string,
    readonly agent: Agent,
    readonly component: AbortSignal,
    private readonly historyWork: DshHistoryWork,
    private readonly releaseHistory: () => Promise<void>,
    readonly features: ResolvedWorkspaceFeatures = workspaceFeatures(),
  ) {
    this.history = historyWork.service;
    this.workers = new McpWorkerRuntime(defaultWorkerDirectory(), agent.id, "dsh");
  }

  check = () => { this.component.throwIfAborted(); this.lifetime.signal.throwIfAborted(); };

  async open() {
    this.check();
    const mcpEntry = resolve(resourceRoot, "../lib/extension/mcp.js");
    const workerDir = defaultWorkerDirectory();
    this.#scope = await this.agent.ctx.plugin({
      name: "pbot-coordinator",
      inject: dshDependencies,
      apply: async ctx => {
        if (this.features.skills) registerDshSkills(ctx, this.agent, { workspaceRoot: this.root });
        if (this.features.prompts) await dshResources(ctx, this.agent, this.root, "coordinator", this.check, "history-coordinator.md");
        registerDshFileEvents(ctx, this.agent, this.root, false, this.check);
        registerDshHistoryTool(ctx, this.agent, this.history, this.lifetime.signal, this.check);
        registerDshHistoryEvents(ctx, this.agent, this.historyWork, this.check);
        if (existsSync(mcpEntry)) {
          await ctx.plugin(McpClient, McpClient.Config({
            transport: "stdio",
            serverName: "pbot",
            command: process.execPath,
            args: [mcpEntry],
            env: {
              ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
              ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
              ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
              PBOT_HOST: "dsh",
              PBOT_WORKSPACE_ROOT: this.root,
              PBOT_MCP_AGENT_DIR: workerDir,
              PBOT_MCP_SESSION_ID: this.agent.id,
            },
            cwd: this.root,
            toolCallTimeoutMs: 600_000,
            failOnStartupError: false,
          }));
        }
        if (this.features.mcp) {
          const mcpConfig = await readWorkspaceMcpConfig(this.root);
          this.check();
          if (mcpConfig.error) {
            this.ctx.logger.warn(mcpConfig.error);
          } else {
            for (const [serverName, server] of Object.entries(mcpConfig.servers)) {
              if (server.enabled === false) continue;
              try {
                const resolved = resolveWorkspaceMcpServer(this.root, serverName, server);
                await ctx.plugin(McpClient, toDshMcpConfig(resolved));
              } catch (error) {
                this.ctx.logger.warn(error instanceof Error ? error.message : String(error));
              }
            }
          }
        }
      },
    });
    this.check();
  }

  close() {
    if (this.#closing) return this.#closing;
    this.lifetime.abort();
    this.#closing = (async () => {
      const errors: unknown[] = [];
      try { await this.workers.close(); } catch (error) { errors.push(error); }
      try { await this.#scope?.dispose(); } catch (error) { errors.push(error); }
      try { await this.releaseHistory(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "dsh 工作区关闭失败；请核对执行资源。");
    })();
    return this.#closing;
  }
}

export class DshWorkspaces {
  readonly #parents = new Map<Agent, Promise<DshWorkspace | undefined>>();
  readonly #initializing = new Map<string, Promise<void>>();
  readonly #configurations = new Map<Agent, { root: string; configuration: WorkspaceConfiguration }>();
  readonly #parentEffects = new Map<Agent, () => Promise<void>>();
  readonly #histories = new Map<string, { work: DshHistoryWork; users: number }>();
  readonly #lifetime = new AbortController();
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
    return {
      work: owned.work,
      release: async () => {
        if (released) return; released = true;
        if (--owned.users === 0) {
          try { await owned.work.close(); } finally { if (this.#histories.get(root) === owned) this.#histories.delete(root); }
        }
      },
    };
  }

  async open(agent: Agent) {
    this.#lifetime.signal.throwIfAborted();
    requireThat(rootAgents(this.ctx.agents).includes(agent), "子会话不拥有协调者管理入口。");
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
        workspace = new DshWorkspace(this.ctx, root, agent, this.#lifetime.signal, history.work, history.release, workspaceFeatures(configuration));
        const owned = workspace;
        const dispose = agent.ctx.effect(() => async () => {
          this.#parents.delete(agent); this.#configurations.delete(agent); this.#parentEffects.delete(agent); await owned.close();
        });
        this.#parentEffects.set(agent, dispose);
        await workspace.open(); this.#lifetime.signal.throwIfAborted();
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
        const errors = [...new Set([...closed, ...effects, ...histories].flatMap(value => value.status === "rejected" ? [value.reason] : []))];
        if (errors.length) throw new AggregateError(errors, "部分 dsh 工作区未能完成关闭。");
      } finally { this.#parents.clear(); this.#configurations.clear(); this.#parentEffects.clear(); this.#histories.clear(); }
    })();
    return this.#closing;
  }
}
