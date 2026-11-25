import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../common/json.js";
import { isAcpBackend, requireThat } from "../common/validation.js";
import { packageVersion } from "../common/version.js";
import { AcpWorkerHost } from "../integrations/acp/agents.js";
import { canonicalAcpBackend, inspectAcpBackends, knownAcpBackends } from "../integrations/acp/launch.js";
import type { AcpCommands, AcpModelSelection } from "../model/acp.js";
import type { AgentCycle, AgentOwner, AgentView } from "../model/agent.js";
import { AgentService } from "../services/agents/agent-service.js";
import { readWorkspaceConfig, workspaceDisabledMessage } from "../services/workspace/workspace-config.js";

const protocolVersion = "2025-03-26";
const readyTimeoutMs = 45_000;
const defaultWaitMs = 50_000;
const maxWaitMs = 600_000;
const reportPageSize = 16_000;
const progressIntervalMs = 5_000;

const workerActions = [
  "start", "send", "wait", "permission", "read", "status", "stop", "backends", "models",
] as const;

const allowedParams = new Set([
  "action", "backend", "message", "model", "thinking", "workerId",
  "decision", "waitMs", "cwd", "permissionId", "offset", "workspace",
]);

export type ProgressReporter = (message: string) => void;

export const mcpInstructions =
  "pbot_worker 用于跨宿主委派其他 Harness（ACP Agent）执行任务；同宿主任务优先由当前宿主或其原生子代理直接完成。";

function formatBackendItem(entry: ReturnType<typeof inspectAcpBackends>[number], defaultBackend?: string): string {
  const tags: string[] = [];
  if (entry.label) tags.push(entry.label);
  else if (!entry.builtin) tags.push("自定义");
  if (entry.backend === defaultBackend) tags.push("当前宿主");
  return tags.length ? `${entry.backend}（${tags.join("，")}）` : entry.backend;
}

function summarizeBackends(commands: AcpCommands = {}, defaultBackend?: string) {
  const entries = inspectAcpBackends(commands);
  const available = entries.filter(item => item.available);
  const unavailable = entries.filter(item => !item.available);
  const availableText = available.map(item => formatBackendItem(item, defaultBackend)).join("、");
  const unavailableText = unavailable.map(item => formatBackendItem(item, defaultBackend)).join("、");
  const overview = available.length
    ? unavailable.length
      ? `本机可用 backend：${availableText}；未检测到：${unavailableText}（详情查 backends）。`
      : `本机可用 backend：${availableText}。`
    : `已注册 backend：${unavailableText}（当前环境未检测到可执行文件，详情查 backends）。`;
  const targetChoices = available.length ? availableText : unavailableText;
  return { overview, targetChoices };
}

export function buildPbotWorkerTool(commands: AcpCommands = {}, defaultBackend?: string, workspaceBound = false) {
  const { overview, targetChoices } = summarizeBackends(commands, defaultBackend);
  const backendDefaultHint = defaultBackend
    ? `省略时回退当前宿主 ${defaultBackend}`
    : "未设置默认宿主时必填";
  return {
    name: "pbot_worker",
    description:
      "跨宿主委派其他 Harness（ACP Agent）执行独立任务。未指定其他程序时优先用当前宿主或其原生子代理。\n" +
      "最常用：action=\"start\" + backend + message（用户未指定模型时省略 model 与 thinking，沿用目标默认）。" +
      "start / send / permission 默认同步等待 50s 并返回结果（传 waitMs: 0 可立即返回异步执行）；" +
      "超时返回 timedOut 后用 wait 续等，返回 needsPermission 向用户确认后用 permission 回复，报告含 nextOffset 时用 read 翻页。" +
      "后续追问同一 worker 用 send（已停止自动恢复），用完可 stop。\n" +
      overview,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [...workerActions],
          description:
            "start 启动新 worker 执行任务；send 发后续消息（已停止自动恢复）；wait 续等运行中 worker；permission 回复待确认权限；read 读/翻页最新报告；status 查单个状态（省略 workerId 列全部）；stop 停止；backends 查可用目标与权限策略；models 查目标可选模型与思考力度。",
        },
        backend: {
          type: "string",
          description: `start / models 使用（${backendDefaultHint}）：目标宿主 Harness，忽略大小写并支持常见别名（如 claude-code / agy）。可用：${targetChoices}。`,
        },
        message: {
          type: "string",
          description: "start / send 必填：发给 worker 的任务或后续指令。worker 看不到当前对话，start 时写清目标、相关文件路径、约束与交付要求。",
        },
        model: {
          type: "string",
          description: "start / models 可选：仅用户指定模型时填（支持精确值、显示名、唯一简名或 provider/model，忽略大小写）；不确定合法值可用 models 查询；省略沿用目标默认。",
        },
        thinking: {
          type: "string",
          description: "start 可选：仅用户指定思考力度时填（常见值 low / medium / high / xhigh / max，忽略大小写）；省略沿用目标默认。",
        },
        workerId: {
          type: "string",
          description: "send / wait / permission / read / stop 必填，status 可选（省略列全部）：start 或 status 返回的 worker ID。",
        },
        decision: {
          type: "string",
          description: "permission 必填：\"allow\"、\"deny\"，或 pendingPermissions[].options[].optionId。",
        },
        waitMs: {
          type: "integer",
          minimum: 0,
          maximum: maxWaitMs,
          description: `start / send / wait / permission 可选：等待毫秒数，默认 ${defaultWaitMs}；start / send / permission 传 0 立即返回异步执行。`,
        },
        cwd: {
          type: "string",
          description: "start 可选：worker 执行子目录（相对工作区根目录或绝对路径），默认工作区根目录。",
        },
        permissionId: {
          type: "string",
          description: "permission 可选：仅同时存在多条待确认权限时传 pendingPermissions[].permissionId。",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "read 可选：报告字符偏移，默认 0；续读传上次 nextOffset。",
        },
        workspace: {
          type: "string",
          description: workspaceBound
            ? "可选：工作区根目录绝对路径；已默认绑定当前工作区，通常省略。"
            : "工作区根目录绝对路径（环境上下文中的 workspaceRoot）；当默认目录不是当前工作区时必填。",
        },
      },
    },
  };
}

export const pbotWorkerTool = buildPbotWorkerTool();

export function defaultWorkerDirectory(): string {
  if (process.env.PBOT_MCP_AGENT_DIR) return process.env.PBOT_MCP_AGENT_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "subagents");
  return join(homedir(), ".pbot/subagents");
}

function rejectUnknownParams(rawArgs: Record<string, unknown>) {
  const unknown = Object.entries(rawArgs)
    .filter(([key, value]) => value !== undefined && !allowedParams.has(key))
    .map(([key]) => key);
  requireThat(unknown.length === 0, `未知参数：${unknown.join(", ")}（可用参数：${[...allowedParams].join(", ")}）。`);
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
    ...(value.pendingPermissions?.length ? { pendingPermissions: value.pendingPermissions } : {}),
    ...(value.cycle ? { cycle: presentCycle(value.cycle) } : {}),
    ...(value.report !== undefined ? { report: value.report } : {}),
    ...(truncated ? { totalLength: value.totalLength, nextOffset: value.nextOffset } : {}),
    ...(value.error ? { error: value.error } : {}),
  };
}

export class McpWorkerRuntime {
  readonly #services = new Map<string, { service: AgentService; host: AcpWorkerHost; owner: AgentOwner }>();
  readonly #sessionId: string;
  readonly #directory: string;
  readonly #defaultBackend: string | undefined;
  #closed = false;

  constructor(
    directory = defaultWorkerDirectory(),
    sessionId = process.env.PBOT_MCP_SESSION_ID || ("mcp-" + randomUUID()),
    defaultBackend = process.env.PBOT_HOST || undefined,
  ) {
    this.#directory = directory;
    this.#sessionId = sessionId;
    this.#defaultBackend = defaultBackend?.trim() || undefined;
  }

  private resolveBackend(rawArgs: Record<string, unknown>, commands?: AcpCommands): string {
    const raw = asString(rawArgs, "backend") ?? this.#defaultBackend;
    requireThat(raw, `缺少必填参数：backend（未能识别当前宿主，请指定目标程序：${knownAcpBackends(commands).join(", ")}）。`);
    const backend = canonicalAcpBackend(raw, commands);
    requireThat(isAcpBackend(backend), "无效的 ACP backend 名称：" + raw);
    return backend;
  }

  private async resolveWorkspace(supplied?: string): Promise<string> {
    const target = supplied || process.env.CLAUDE_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT || process.cwd();
    requireThat(isAbsolute(target), "工作区需要绝对路径。");
    const root = await realpath(target);
    requireThat((await stat(root)).isDirectory(), "工作区路径不是目录。");
    return root;
  }

  private async workspace(supplied?: string) {
    requireThat(!this.#closed, "Personal Bot MCP 服务已关闭。");
    const root = await this.resolveWorkspace(supplied);
    const configuration = await readWorkspaceConfig(root);
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
    let entry = this.#services.get(root);
    if (!entry) {
      const host = new AcpWorkerHost(this.#directory, configuration.acp);
      entry = {
        host,
        service: new AgentService(root, this.#directory, host),
        owner: { sessionId: this.#sessionId, leaf: null, branch: [] },
      };
      this.#services.set(root, entry);
    } else {
      Object.assign(entry.host, { commands: configuration.acp ?? {} });
    }
    return { root, configuration, ...entry };
  }

  async toolDefinition() {
    let commands: AcpCommands | undefined;
    try {
      const root = await this.resolveWorkspace();
      const configuration = await readWorkspaceConfig(root);
      if (configuration.enabled) commands = configuration.acp;
    } catch { /* Fall back to registered built-in harnesses when cwd is outside an enabled workspace. */ }
    const defaultBackend = this.#defaultBackend ? canonicalAcpBackend(this.#defaultBackend, commands) : undefined;
    const workspaceBound = Boolean(process.env.CLAUDE_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT);
    return buildPbotWorkerTool(commands, defaultBackend, workspaceBound);
  }

  /** Wait until ACP handshake and model/thinking configuration finish so invalid options fail synchronously on start/resume. */
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
      requireThat(!this.#closed, "Personal Bot MCP 服务已关闭。");
      const current = service.status(workerId, owner);
      if (current.selection !== undefined) return current;
      if (current.state === "error" || current.state === "stopped") {
        throw new Error(current.error || "ACP worker 启动失败。");
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
    progress?: ProgressReporter,
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastProgressAt = 0;
    let lastMarker = "";
    for (;;) {
      requireThat(!this.#closed, "Personal Bot MCP 服务已关闭。");
      const current = service.status(workerId, owner);
      const cycles = service.cycles(workerId, owner);
      const latestRequest = requestId ?? service.files.messages(workerId)
        .filter(item => item.generation === current.generation)
        .at(-1)?.requestId;
      const targetCycle = latestRequest
        ? cycles.find(item => item.generation === current.generation && item.requestIds.includes(latestRequest))
        : current.cycle ?? cycles.at(-1);
      const settled = targetCycle && targetCycle.state !== "running";
      const terminalWithoutCycle = !latestRequest && (current.state === "stopped" || current.state === "error" || (current.state === "idle" && !targetCycle));
      const failedBeforeCycle = Boolean(latestRequest && !targetCycle && (current.state === "stopped" || current.state === "error"));
      if (settled) {
        const page = await service.read(workerId, owner, targetCycle.cycleId, 0, reportPageSize);
        return { settled: true, ...presentWorker(page) };
      }
      if (terminalWithoutCycle || failedBeforeCycle) {
        return { settled: true, ...presentWorker(current) };
      }
      if (current.pendingPermissions?.length) {
        return {
          settled: false,
          needsPermission: true,
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

  async callTool(name: string, rawArgs: unknown, progress?: ProgressReporter): Promise<unknown> {
    requireThat(name === "pbot_worker", "未知工具：" + name);
    requireThat(object(rawArgs), "工具参数必须是对象。");
    rejectUnknownParams(rawArgs);
    const action = asString(rawArgs, "action", true)!;
    const { root, configuration, host, service, owner } = await this.workspace(asString(rawArgs, "workspace"));

    switch (action) {
      case "backends":
        return { backends: inspectAcpBackends(configuration.acp) };
      case "models": {
        const backend = this.resolveBackend(rawArgs, configuration.acp);
        const model = asString(rawArgs, "model");
        return await host.inspectModels(backend, root, {
          ...(model ? { model } : {}),
        });
      }
      case "start": {
        const backend = this.resolveBackend(rawArgs, configuration.acp);
        const message = asString(rawArgs, "message", true)!;
        const model = asString(rawArgs, "model");
        const thinking = asString(rawArgs, "thinking");
        const cwd = asString(rawArgs, "cwd");
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        const startedAt = Date.now();
        const created = await service.start({
          backend,
          message,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(cwd ? { cwd } : {}),
        }, owner);
        const ready = await this.waitReady(service, owner, created.agentId, waitMs > 0 ? Math.min(waitMs, readyTimeoutMs) : readyTimeoutMs, progress);
        if (waitMs > 0 && created.requestId) {
          const remaining = Math.max(0, waitMs - (Date.now() - startedAt));
          return this.waitFor(service, owner, created.agentId, created.requestId, remaining, progress);
        }
        return {
          ...presentWorker(ready),
          ...(ready.pendingPermissions?.length ? { settled: false, needsPermission: true } : {}),
        };
      }
      case "send": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const message = asString(rawArgs, "message", true)!;
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        const current = service.status(workerId, owner);
        requireThat(current.state !== "stopping", "worker 正在停止，请稍后重试。");
        if (current.alive) {
          const sent = service.send(workerId, message, "followUp", owner);
          if (waitMs > 0) return this.waitFor(service, owner, workerId, sent.requestId, waitMs, progress);
          return presentWorker(sent);
        }
        const startedAt = Date.now();
        const resumed = await service.resume(workerId, message, owner);
        const ready = await this.waitReady(service, owner, workerId, waitMs > 0 ? Math.min(waitMs, readyTimeoutMs) : readyTimeoutMs, progress);
        if (waitMs > 0 && resumed.requestId) {
          const remaining = Math.max(0, waitMs - (Date.now() - startedAt));
          return this.waitFor(service, owner, workerId, resumed.requestId, remaining, progress);
        }
        return {
          ...presentWorker(ready),
          ...(ready.pendingPermissions?.length ? { settled: false, needsPermission: true } : {}),
        };
      }
      case "wait": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        return this.waitFor(service, owner, workerId, undefined, waitMs, progress);
      }
      case "permission": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const permissionId = asString(rawArgs, "permissionId");
        const decision = asString(rawArgs, "decision", true)!;
        const waitMs = asInt(rawArgs, "waitMs", 0, maxWaitMs) ?? defaultWaitMs;
        const updated = service.answerPermission(workerId, permissionId, decision, owner);
        if (waitMs > 0) return this.waitFor(service, owner, workerId, undefined, waitMs, progress);
        return presentWorker(updated);
      }
      case "read": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const offset = asInt(rawArgs, "offset", 0, 10_000_000);
        return presentWorker(await service.read(workerId, owner, undefined, offset, reportPageSize));
      }
      case "status": {
        const workerId = asString(rawArgs, "workerId");
        if (!workerId) return { workers: service.list(owner).map(presentWorker) };
        return presentWorker(service.status(workerId, owner));
      }
      case "stop":
        return presentWorker(service.stop(asString(rawArgs, "workerId", true)!, owner));
      default:
        throw new Error(`未知 action：${action}（可用：${workerActions.join(", ")}）。`);
    }
  }

  async close(preserve = false): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#services.values()];
    this.#services.clear();
    await Promise.allSettled(entries.map(({ service, owner }) => service.close(owner, preserve)));
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
          instructions: mcpInstructions,
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: [await runtime.toolDefinition()] } };
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
