import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../../common/json.js";
import { isAcpBackend, isHistoryIdentifier, isOneOf, requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";
import { packageVersion } from "../../common/version.js";
import { AcpWorkerHost } from "../../integrations/acp/agents.js";
import { canonicalAcpBackend, inspectAcpBackends, knownAcpBackends } from "../../integrations/acp/launch.js";
import { pluginMcpWorkspaceRoot } from "../../integrations/hosts/plugin-registry.js";
import {
  mcpWorkerToolNames,
  type AcpCommands,
  acpElicitationActions, isAcpElicitationValue,
  type AcpElicitationContent,
  type AcpModelSelection,
  type McpWorkerToolName,
} from "../../model/acp.js";
import {
  buildHistoryMcpTools, buildPbotWorkerTools, buildWorkspaceMcpTools, defaultWaitMs, discoverTargets,
  maxWaitMs, parseMcpToolCall,
} from "./tool-contract.js";

import { historyPageLimits } from "../../model/history.js";
import type { AgentCycle, AgentOwner, AgentView } from "../../model/agent.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { readWorkspaceHistory, searchWorkspaceHistory } from "../../services/history/history-query.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { WorkspaceMcpBridge } from "./bridge.js";

export { buildHistoryMcpTools, buildPbotWorkerTools, buildWorkspaceMcpTools, pbotWorkerTools } from "./tool-contract.js";

const protocolVersion = "2025-03-26";
const readyTimeoutMs = 45_000;
const reportPageSize = 16_000;
const progressIntervalMs = 5_000;

export type ProgressReporter = (message: string) => void;

export const mcpWorkerOnlyInstructions =
  "提供跨助手协作能力（worker_*）：可启动并调度其他外部 AI 助手在当前工作区中独立执行任务，适用于用户指定其他助手、需要特定模型或思考深度、获取独立审查/第二意见，或并行处理子任务。不需要借助其他助手时，优先自行完成或使用当前内置子代理。\n" +
  "使用流程：用 worker_create 启动目标助手（或用 worker_discover 复用已有会话）→ 用 worker_request 派发任务或继续追问 → 任务完成后可用 worker_close 结束会话。后台等待、超时续等（timedOut）或长结果翻页（nextOffset）用 worker_output；助手请求授权或提问（needsResponse）时，先向用户确认，再用 worker_response 回复。";

export const mcpInstructions =
  "提供三类能力：\n" +
  "1. 跨助手协作（worker_*）：启动并调度其他外部 AI 助手在当前工作区中独立执行任务，适用于用户指定其他助手、需要特定模型或思考深度、获取独立审查/第二意见，或并行处理子任务。不需要借助其他助手时，优先自行完成或使用当前内置子代理。使用流程：worker_create 启动助手（或 worker_discover 复用已有会话）→ worker_request 派发任务或追问 → 完成后 worker_close 结束；后台等待、超时续等（timedOut）或长结果翻页（nextOffset）用 worker_output；返回 needsResponse 时先向用户确认，再用 worker_response 回复。\n" +
  "2. 工作区共享外部工具（workspace_mcp_*）：发现并调用当前工作区接入的外部工具服务与数据源（可与当前环境原生工具同时使用）。先用 workspace_mcp_discover 查看可用服务与工具说明，再用 workspace_mcp_call 调用。\n" +
  "3. 跨宿主历史查询（history_search / history_read）：只读检索当前工作区在 Pi、dsh、Claude Code、Antigravity 等宿主中记录的历史问答与摘要归档。";

export function defaultWorkerDirectory(): string {
  if (process.env.PBOT_MCP_AGENT_DIR) return process.env.PBOT_MCP_AGENT_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "subagents");
  return join(homedir(), ".pbot/subagents");
}

function workerCommandTool(name: string): McpWorkerToolName | undefined {
  const full = name.startsWith("worker_") ? name : `worker_${name}`;
  return isOneOf(full, mcpWorkerToolNames) ? full : undefined;
}

/** Parse Pi/dsh `/pbot worker ...` CLI arguments into a canonical MCP tool call. */
export function parseWorkerCommand(raw: string): { tool: McpWorkerToolName; args: Record<string, unknown> } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "overview") return { tool: "worker_discover", args: { target: "overview" } };
  if (trimmed === "status" || trimmed === "list" || trimmed === "workers") {
    return { tool: "worker_discover", args: { target: "workers" } };
  }
  if (trimmed.startsWith("status ") || trimmed.startsWith("workers ")) {
    const workerId = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    requireThat(workerId.length > 0, "请提供 workerId。");
    return { tool: "worker_discover", args: { target: "workers", workerId } };
  }
  if (trimmed === "backends") return { tool: "worker_discover", args: { target: "backends" } };
  if (trimmed === "models") return { tool: "worker_discover", args: { target: "models" } };
  if (trimmed.startsWith("models ")) {
    const backend = trimmed.slice(7).trim();
    requireThat(backend.length > 0, "请提供 backend 名称。");
    return { tool: "worker_discover", args: { target: "models", backend } };
  }
  if (trimmed.startsWith("close ")) {
    const rest = trimmed.slice(6).trim();
    if (!rest.startsWith("{")) {
      requireThat(rest.length > 0, "请提供要关闭的 workerId。");
      return { tool: "worker_close", args: { workerId: rest } };
    }
  }
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    requireThat(object(parsed), 'worker 参数必须是 JSON 对象，例如：/pbot worker create {"backend":"codex"}');
    const resolved = typeof parsed.tool === "string" ? workerCommandTool(parsed.tool) : undefined;
    requireThat(resolved, `JSON 形式需包含有效 tool 字段（${mcpWorkerToolNames.join(", ")}），或使用 /pbot worker <工具名> <JSON>。`);
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "tool"));
    return { tool: resolved, args: rest };
  }
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();
  const tool = workerCommandTool(verb);
  requireThat(tool, `未知 worker 命令：${verb}（支持：overview | status | backends | models | ${mcpWorkerToolNames.map(name => name.slice("worker_".length)).join(" | ")}）。`);
  if (!rest) return { tool, args: {} };
  const parsed: unknown = JSON.parse(rest);
  requireThat(object(parsed), `${tool} 的参数必须是 JSON 对象。`);
  return { tool, args: parsed };
}

function asString(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    requireThat(!required, `缺少必填参数：${key}`);
    return undefined;
  }
  requireThat(typeof value === "string" && value.length > 0, `参数 ${key} 必须是非空字符串。`);
  return value;
}

function asInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  requireThat(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max,
    `参数 ${key} 必须是 ${min}–${max} 的整数。`);
  return value;
}

function asContent(args: Record<string, unknown>, key: string): AcpElicitationContent | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  requireThat(object(value), `参数 ${key} 必须是 JSON 对象。`);
  for (const [field, entry] of Object.entries(value)) {
    requireThat(isAcpElicitationValue(entry), `参数 ${key}.${field} 必须是字符串、数字、布尔值或字符串数组。`);
  }
  return value as AcpElicitationContent;
}

function presentCycle(cycle: AgentCycle) {
  return {
    state: cycle.state,
    ...(cycle.error ? { error: cycle.error } : {}),
  };
}

function presentSelection(selection?: AcpModelSelection) {
  if (!selection) return undefined;
  const entries = Object.entries(selection).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function presentWorker(value: AgentView & {
  report?: string;
  totalLength?: number;
  nextOffset?: number | null;
}) {
  const selection = presentSelection(value.selection);
  const truncated = value.nextOffset !== undefined && value.nextOffset !== null;
  return {
    workerId: value.agentId,
    backend: value.backend,
    state: value.state,
    activity: value.activity,
    alive: value.alive,
    ...(selection ? { selection } : {}),
    ...(value.pendingRequests?.length ? { pendingRequests: value.pendingRequests } : {}),
    ...(value.cycle ? { cycle: presentCycle(value.cycle) } : {}),
    ...(value.report !== undefined ? { report: value.report } : {}),
    ...(truncated ? { totalLength: value.totalLength, nextOffset: value.nextOffset } : {}),
    ...(value.error ? { error: value.error } : {}),
  };
}

export class McpWorkerRuntime {
  readonly #services = new Map<string, { service: AgentService; host: AcpWorkerHost; owner: AgentOwner }>();
  readonly #bridge = new WorkspaceMcpBridge();
  readonly #sessionId: string;
  readonly #directory: string;
  readonly #defaultBackend: string | undefined;
  readonly #nativeWorkspaceMcp: boolean;
  readonly #nativeHistory: boolean;
  #closing: Promise<void> | undefined;

  constructor(
    directory = defaultWorkerDirectory(),
    sessionId = process.env.PBOT_MCP_SESSION_ID || ("mcp-" + randomUUID()),
    defaultBackend = process.env.PBOT_HOST || undefined,
    nativeWorkspaceMcp = /^(1|true)$/i.test(process.env.PBOT_NATIVE_WORKSPACE_MCP ?? ""),
    nativeHistory = /^(1|true)$/i.test(process.env.PBOT_NATIVE_HISTORY ?? ""),
  ) {
    this.#directory = directory;
    this.#sessionId = sessionId;
    this.#defaultBackend = defaultBackend?.trim() || undefined;
    this.#nativeWorkspaceMcp = nativeWorkspaceMcp;
    this.#nativeHistory = nativeHistory;
  }

  /** Mount the stdio sibling with the same worker ownership as the native host command. */
  nativeServer(root: string) {
    const entry = join(resourceRoot, "../lib/extension/mcp.js");
    if (!existsSync(entry)) return undefined;
    requireThat(this.#defaultBackend, "原生 MCP 挂载需要宿主名称。");
    return {
      command: process.execPath,
      args: [entry],
      env: {
        PBOT_HOST: this.#defaultBackend,
        PBOT_WORKSPACE_ROOT: root,
        PBOT_MCP_AGENT_DIR: this.#directory,
        PBOT_MCP_SESSION_ID: this.#sessionId,
        PBOT_NATIVE_WORKSPACE_MCP: "1",
        PBOT_NATIVE_HISTORY: "1",
      },
    };
  }

  get nativeWorkspaceMcp(): boolean {
    return this.#nativeWorkspaceMcp;
  }

  get nativeHistory(): boolean {
    return this.#nativeHistory;
  }

  private resolveBackend(rawArgs: Record<string, unknown>, commands: AcpCommands | undefined, allowDefault: boolean): string {
    const raw = asString(rawArgs, "backend") ?? (allowDefault ? this.#defaultBackend : undefined);
    requireThat(raw, `缺少必填参数：backend（请指定目标程序：${knownAcpBackends(commands).join(", ")}）。`);
    const backend = canonicalAcpBackend(raw, commands);
    requireThat(isAcpBackend(backend), "无效的 backend 名称：" + raw);
    return backend;
  }

  private async resolveWorkspace(supplied?: string): Promise<string> {
    const target = supplied || pluginMcpWorkspaceRoot() || process.cwd();
    requireThat(isAbsolute(target), "工作区需要绝对路径。");
    const root = await realpath(target);
    requireThat((await stat(root)).isDirectory(), "工作区路径不是目录。");
    return root;
  }

  private workerService(root: string, commands: AcpCommands = {}) {
    let entry = this.#services.get(root);
    if (!entry) {
      const host = new AcpWorkerHost(this.#directory, commands);
      entry = {
        host,
        service: new AgentService(root, this.#directory, host),
        owner: { sessionId: this.#sessionId, leaf: null, branch: [] },
      };
      this.#services.set(root, entry);
    } else {
      entry.host.commands = commands;
    }
    return entry;
  }

  async toolDefinitions() {
    let commands: AcpCommands | undefined;
    let includeWorkspaceMcp = !this.#nativeWorkspaceMcp;
    let includeHistory = !this.#nativeHistory;
    try {
      const root = await this.resolveWorkspace();
      const configuration = await readWorkspaceConfig(root);
      if (configuration.enabled) {
        commands = configuration.acp;
        const features = workspaceFeatures(configuration);
        includeWorkspaceMcp = !this.#nativeWorkspaceMcp && features.mcp;
        includeHistory = !this.#nativeHistory && features.history;
      }
    } catch { /* Fall back to registered built-in harnesses when cwd is outside an enabled workspace. */ }
    const defaultBackend = this.#defaultBackend ? canonicalAcpBackend(this.#defaultBackend, commands) : undefined;
    const workspaceBound = Boolean(pluginMcpWorkspaceRoot());
    return [
      ...buildPbotWorkerTools(commands, defaultBackend, workspaceBound),
      ...(includeWorkspaceMcp ? buildWorkspaceMcpTools(workspaceBound) : []),
      ...(includeHistory ? buildHistoryMcpTools(workspaceBound) : []),
    ];
  }

  /** Wait until ACP handshake and model/thinking configuration finish so invalid options fail synchronously on create/resume. */
  private async waitReady(
    service: AgentService,
    owner: AgentOwner,
    workerId: string,
    timeoutMs: number,
    progress?: ProgressReporter,
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastProgressAt = 0;
    let lastMarker = "";
    for (;;) {
      requireThat(!this.#closing, "Personal Bot MCP 服务已关闭。");
      const current = service.status(workerId, owner);
      if (current.state === "error" || current.state === "stopped") {
        throw new Error(current.error || "worker 启动失败。");
      }
      if (current.state === "idle" || current.state === "busy") return current;
      if (Date.now() >= deadline) return current;
      if (progress) {
        const marker = `${current.state}:${current.activity}`;
        const now = Date.now();
        if (marker !== lastMarker || now - lastProgressAt >= progressIntervalMs) {
          lastMarker = marker;
          lastProgressAt = now;
          progress(`${current.backend}: ${current.activity}`);
        }
      }
      await delay(50);
    }
  }

  private async waitFor(
    service: AgentService,
    owner: AgentOwner,
    workerId: string,
    requestId: string | undefined,
    timeoutMs: number,
    offset = 0,
    progress?: ProgressReporter,
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastProgressAt = 0;
    let lastMarker = "";
    for (;;) {
      requireThat(!this.#closing, "Personal Bot MCP 服务已关闭。");
      const { current, cycle, terminal } = service.outputStatus(workerId, owner, requestId);
      if (cycle && cycle.state !== "running") {
        const page = await service.read(workerId, owner, cycle.cycleId, offset, reportPageSize);
        return { settled: true, ...presentWorker(page) };
      }
      if (terminal) {
        if (offset > 0) await service.read(workerId, owner, undefined, offset, reportPageSize);
        return { settled: true, ...presentWorker(current) };
      }
      if (current.pendingRequests?.length) {
        return {
          settled: false,
          needsResponse: true,
          ...presentWorker(current),
        };
      }
      if (Date.now() >= deadline) {
        return { settled: false, timedOut: true, ...presentWorker(current) };
      }
      if (progress) {
        const marker = `${current.state}:${current.activity}`;
        const now = Date.now();
        if (marker !== lastMarker || now - lastProgressAt >= progressIntervalMs) {
          lastMarker = marker;
          lastProgressAt = now;
          progress(`${current.backend}: ${current.activity}`);
        }
      }
      await delay(100);
    }
  }

  async callTool(toolName: string, input: unknown, progress?: ProgressReporter): Promise<unknown> {
    const { name, args: rawArgs } = parseMcpToolCall(toolName, input);
    requireThat(!this.#closing, "Personal Bot MCP 服务已关闭。");
    const root = await this.resolveWorkspace(asString(rawArgs, "workspace"));
    const configuration = await readWorkspaceConfig(root);
    requireThat(!this.#closing, "Personal Bot MCP 服务已关闭。");
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));

    switch (name) {
      case "workspace_mcp_discover":
      case "workspace_mcp_call": {
        requireThat(!this.#nativeWorkspaceMcp, "当前宿主已原生挂载工作区 .pbot/mcp.json 服务，请直接调用对应原生 MCP 工具，勿重复经由 workspace_mcp_* 桥接。");
        requireThat(workspaceFeatures(configuration).mcp, `工作区统一 MCP 功能已在 ${configuration.path} 中停用（features.mcp: false）。`);
        if (name === "workspace_mcp_discover") return this.#bridge.discover(root, asString(rawArgs, "server"));
        const server = asString(rawArgs, "server", true)!;
        const tool = asString(rawArgs, "tool", true)!;
        const toolArgs = rawArgs.arguments === undefined ? {} : rawArgs.arguments;
        requireThat(object(toolArgs), "参数 arguments 必须是 JSON 对象。");
        return this.#bridge.call(root, server, tool, toolArgs);
      }
      case "history_search": {
        requireThat(!this.#nativeHistory, "当前宿主已提供原生 pbot_history 工具，请直接调用 pbot_history。");
        requireThat(workspaceFeatures(configuration).history, `工作区历史功能已在 ${configuration.path} 中停用（features.history: false）。`);
        const hostFilter = asString(rawArgs, "host");
        if (hostFilter !== undefined) requireThat(isHistoryIdentifier(hostFilter), "无效的 host 来源：" + hostFilter);
        const dimension = asString(rawArgs, "dimension");
        if (dimension !== undefined) requireThat(isHistoryIdentifier(dimension), "无效的 dimension：" + dimension);
        const query = asString(rawArgs, "query");
        const sessionId = asString(rawArgs, "sessionId");
        const from = asString(rawArgs, "from");
        const to = asString(rawArgs, "to");
        const offset = asInt(rawArgs, "offset", 0, 10_000_000) ?? 0;
        const limit = asInt(rawArgs, "limit", 1, historyPageLimits.search.max) ?? historyPageLimits.search.default;
        return searchWorkspaceHistory(root, {
          ...(hostFilter ? { host: hostFilter } : {}),
          ...(dimension ? { dimension } : {}),
          ...(query ? { query } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          offset,
          limit,
        });
      }
      case "history_read": {
        requireThat(!this.#nativeHistory, "当前宿主已提供原生 pbot_history 工具，请直接调用 pbot_history。");
        requireThat(workspaceFeatures(configuration).history, `工作区历史功能已在 ${configuration.path} 中停用（features.history: false）。`);
        const id = asString(rawArgs, "id", true)!;
        const hostFilter = asString(rawArgs, "host");
        if (hostFilter !== undefined) requireThat(isHistoryIdentifier(hostFilter), "无效的 host 来源：" + hostFilter);
        const offset = asInt(rawArgs, "offset", 0, 10_000_000) ?? 0;
        const limit = asInt(rawArgs, "limit", 1, historyPageLimits.read.max) ?? historyPageLimits.read.default;
        const childrenOffset = asInt(rawArgs, "childrenOffset", 0, 10_000_000) ?? 0;
        return { node: readWorkspaceHistory(root, id, offset, limit, childrenOffset, hostFilter) };
      }
    }

    const { host, service, owner } = this.workerService(root, configuration.acp);
    switch (name) {
      case "worker_create": {
        const backend = this.resolveBackend(rawArgs, configuration.acp, false);
        const model = asString(rawArgs, "model");
        const thinking = asString(rawArgs, "thinking");
        const cwd = asString(rawArgs, "cwd");
        const created = await service.start({
          backend,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(cwd ? { cwd } : {}),
        }, owner);
        const ready = await this.waitReady(service, owner, created.agentId, readyTimeoutMs, progress);
        return {
          ...presentWorker(ready),
          capabilities: { resume: ready.capabilities.resume },
        };
      }
      case "worker_close":
        return presentWorker(service.stop(asString(rawArgs, "workerId", true)!, owner));
      case "worker_request": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const message = asString(rawArgs, "message", true)!;
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        const current = service.status(workerId, owner);
        requireThat(current.state !== "stopping", "worker 正在停止，请稍后重试。");
        if (current.alive) {
          const sent = service.send(workerId, message, "followUp", owner);
          if (waitMs > 0) return this.waitFor(service, owner, workerId, sent.requestId, waitMs, 0, progress);
          return presentWorker(sent);
        }
        const startedAt = Date.now();
        const resumed = await service.resume(workerId, message, owner);
        const ready = await this.waitReady(service, owner, workerId, waitMs > 0 ? Math.min(waitMs, readyTimeoutMs) : readyTimeoutMs, progress);
        if (waitMs > 0 && resumed.requestId) {
          const remaining = Math.max(0, waitMs - (Date.now() - startedAt));
          return this.waitFor(service, owner, workerId, resumed.requestId, remaining, 0, progress);
        }
        return {
          ...presentWorker(ready),
          ...(ready.pendingRequests?.length ? { settled: false, needsResponse: true } : {}),
        };
      }
      case "worker_response": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const action = asString(rawArgs, "action", true)!;
        requireThat(isOneOf(action, acpElicitationActions),
          `参数 action 无效：${action}（可用：${acpElicitationActions.join(", ")}）。`);
        const requestId = asString(rawArgs, "requestId");
        const optionId = asString(rawArgs, "optionId");
        const content = asContent(rawArgs, "content");
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        const updated = service.respond(workerId, {
          action,
          ...(requestId ? { requestId } : {}),
          ...(optionId ? { optionId } : {}),
          ...(content !== undefined ? { content } : {}),
        }, owner);
        if (waitMs > 0) return this.waitFor(service, owner, workerId, undefined, waitMs, 0, progress);
        return presentWorker(updated);
      }
      case "worker_output": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const offset = asInt(rawArgs, "offset", 0, 10_000_000) ?? 0;
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        return this.waitFor(service, owner, workerId, undefined, waitMs, offset, progress);
      }
      case "worker_discover": {
        const rawTarget = asString(rawArgs, "target") ?? "overview";
        requireThat(isOneOf(rawTarget, discoverTargets),
          `参数 target 无效：${rawTarget}（可用：${discoverTargets.join(", ")}）。`);
        const target = rawTarget;
        const workerId = asString(rawArgs, "workerId");
        const backendRaw = asString(rawArgs, "backend");
        const model = asString(rawArgs, "model");
        if (target !== "workers") {
          requireThat(workerId === undefined, '参数 workerId 仅在 target="workers" 时可用。');
        }
        if (target !== "models") {
          requireThat(backendRaw === undefined && model === undefined, '参数 backend / model 仅在 target="models" 时可用。');
        }
        if (target === "overview") {
          return {
            target,
            backends: inspectAcpBackends(configuration.acp),
            workers: service.list(owner).map(presentWorker),
          };
        }
        if (target === "backends") {
          return { target, backends: inspectAcpBackends(configuration.acp) };
        }
        if (target === "workers") {
          return {
            target,
            workers: workerId
              ? [presentWorker(service.status(workerId, owner))]
              : service.list(owner).map(presentWorker),
          };
        }
        const backend = this.resolveBackend(rawArgs, configuration.acp, true);
        return {
          target,
          ...(await host.inspectModels(backend, root, { ...(model ? { model } : {}) })),
        };
      }
    }
    throw new Error(`未知工具：${name satisfies never}`);
  }

  close(preserve = false): Promise<void> {
    if (this.#closing) return this.#closing;
    const entries = [...this.#services.values()];
    this.#services.clear();
    this.#closing = Promise.allSettled([
      this.#bridge.close(),
      ...entries.map(({ service, owner }) => service.close(owner, preserve)),
    ]).then(() => {});
    return this.#closing;
  }
}

export async function handleMcpRequest(
  runtime: McpWorkerRuntime,
  message: unknown,
  notify?: (notification: Record<string, unknown>) => void,
): Promise<Record<string, unknown> | null> {
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  const hasId = Object.hasOwn(message, "id") && message.id !== undefined;
  const id = hasId ? message.id : null;
  if (!hasId) return null; // Notifications expect no response.

  try {
    if (message.method === "initialize") {
      const requested = object(message.params) && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested || protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "personal-bot", version: packageVersion },
          instructions: runtime.nativeWorkspaceMcp ? mcpWorkerOnlyInstructions : mcpInstructions,
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: await runtime.toolDefinitions() } };
    }
    if (message.method === "tools/call") {
      requireThat(object(message.params) && typeof message.params.name === "string", "tools/call 缺少 name。");
      const meta = object(message.params._meta) ? message.params._meta : undefined;
      const progressToken = meta && (typeof meta.progressToken === "string" || typeof meta.progressToken === "number")
        ? meta.progressToken
        : undefined;
      let progressStep = 0;
      const progress: ProgressReporter | undefined = progressToken !== undefined && notify
        ? (statusMessage: string) => {
          progressStep++;
          notify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress: progressStep, message: statusMessage },
          });
        }
        : undefined;
      try {
        const result = await runtime.callTool(message.params.name, message.params.arguments ?? {}, progress);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + message.method } };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function serveMcpStdio(runtime = new McpWorkerRuntime()): Promise<void> {
  const shutdown = () => { void runtime.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  let buffer = "";
  const pending = new Set<Promise<void>>();
  const write = (value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); };
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      const task = handleMcpRequest(runtime, parsed, write)
        .then(reply => { if (reply) write(reply); })
        .catch(error => {
          const id = object(parsed) && Object.hasOwn(parsed, "id") && parsed.id !== undefined ? parsed.id : null;
          if (id !== null) write({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        })
        .finally(() => { pending.delete(task); });
      pending.add(task);
    }
  }
  await Promise.allSettled(pending);
  await runtime.close();
}
