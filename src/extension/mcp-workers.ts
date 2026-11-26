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
import {
  mcpWorkerToolNames,
  type AcpCommands,
  type AcpElicitationAction,
  type AcpElicitationContent,
  type AcpModelSelection,
  type McpWorkerToolName,
} from "../model/acp.js";
import { workspaceMcpToolNames, type WorkspaceMcpToolName } from "../model/workspace-mcp.js";
import type { AgentCycle, AgentOwner, AgentView } from "../model/agent.js";
import { AgentService } from "../services/agents/agent-service.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../services/workspace/workspace-config.js";
import { WorkspaceMcpBridge } from "./mcp-bridge.js";

const protocolVersion = "2025-03-26";
const readyTimeoutMs = 45_000;
const defaultWaitMs = 50_000;
const maxWaitMs = 600_000;
const reportPageSize = 16_000;
const progressIntervalMs = 5_000;

const responseActions = ["accept", "decline", "cancel"] as const;
const discoverTargets = ["overview", "workers", "backends", "models"] as const;
type DiscoverTarget = typeof discoverTargets[number];

type AllMcpToolName = McpWorkerToolName | WorkspaceMcpToolName;
const allMcpToolNames: readonly AllMcpToolName[] = [...mcpWorkerToolNames, ...workspaceMcpToolNames];

const toolParams: Record<AllMcpToolName, ReadonlySet<string>> = {
  worker_create: new Set(["backend", "model", "thinking", "cwd", "workspace"]),
  worker_close: new Set(["workerId", "workspace"]),
  worker_request: new Set(["workerId", "message", "waitMs", "workspace"]),
  worker_response: new Set(["workerId", "action", "requestId", "optionId", "content", "waitMs", "workspace"]),
  worker_output: new Set(["workerId", "offset", "waitMs", "workspace"]),
  worker_discover: new Set(["target", "workerId", "backend", "model", "workspace"]),
  workspace_mcp_discover: new Set(["server", "workspace"]),
  workspace_mcp_call: new Set(["server", "tool", "arguments", "workspace"]),
};

const shortToolMap: Record<string, McpWorkerToolName> = {
  create: "worker_create",
  close: "worker_close",
  request: "worker_request",
  response: "worker_response",
  output: "worker_output",
  discover: "worker_discover",
};

export type ProgressReporter = (message: string) => void;

export const mcpInstructions =
  "用于跨代理程序委派任务（worker_*）与调用工作区统一注册的外部 MCP 服务（workspace_mcp_*）；未指定其他程序时，优先由当前程序或其原生子代理直接完成。\n" +
  "跨程序委派：worker_create 创建 worker（或用 worker_discover 复用已有 worker）→ worker_request 发送任务或后续消息 → 用完可用 worker_close 关闭；后台等待、超时续等（timedOut）或长报告翻页（nextOffset）用 worker_output；返回 needsResponse 时向用户确认后用 worker_response 回复。\n" +
  "工作区统一 MCP（.pbot/mcp.json）：先用 workspace_mcp_discover 查看已注册服务或指定服务的工具清单，再用 workspace_mcp_call 调用目标工具；可与宿主原生 MCP 同时使用。";

function formatBackendItem(entry: ReturnType<typeof inspectAcpBackends>[number], defaultBackend?: string): string {
  const tags: string[] = [];
  if (entry.label) tags.push(entry.label);
  if (entry.backend === defaultBackend) tags.push("当前");
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
      ? `可用 backend：${availableText}；不可用：${unavailableText}。`
      : `可用 backend：${availableText}。`
    : `当前无可用 backend（不可用：${unavailableText}）。`;
  const availableIds = available.map(item => item.backend).join("、");
  return { overview, availableIds };
}

function workspaceProperty(workspaceBound: boolean) {
  return {
    type: "string",
    description: workspaceBound
      ? "工作区根目录绝对路径；已默认绑定当前工作区，通常省略。"
      : "工作区根目录绝对路径（上下文提供 workspaceRoot 时传该路径）；当前未默认绑定，请显式传入。",
  };
}

export function buildPbotWorkerTools(commands: AcpCommands = {}, defaultBackend?: string, workspaceBound = false) {
  const { overview, availableIds } = summarizeBackends(commands, defaultBackend);
  const modelsBackendHint = defaultBackend
    ? `省略时默认查 ${defaultBackend}`
    : "必填";
  const workspace = workspaceProperty(workspaceBound);

  return [
    {
      name: "worker_create",
      description:
        "创建一个新的 worker 并返回其 workerId（仅创建，不发送任务；随后用 worker_request 派发任务）。" +
        "未指定其他程序时优先由当前程序或其原生子代理完成。\n" +
        overview,
      annotations: {
        title: "Create Worker",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["backend"],
        properties: {
          backend: {
            type: "string",
            description: "目标代理程序名称，不区分大小写，支持常见别名（如 claude-code、agy）。",
          },
          model: {
            type: "string",
            description: "仅用户明确指定模型时传入（支持模型 ID、显示名或 provider/model，不区分大小写）；不确定合法值可用 worker_discover(target=\"models\") 查询；省略则使用目标默认。",
          },
          thinking: {
            type: "string",
            description: "仅用户明确指定思考力度时传入（如 low / medium / high / xhigh / max，不区分大小写）；省略则使用目标默认。",
          },
          cwd: {
            type: "string",
            description: "worker 工作目录（相对工作区根目录或绝对路径），默认为工作区根目录。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_close",
      description:
        "关闭指定 worker。若该 worker 支持恢复（capabilities.resume 为 true），后续仍可直接用 worker_request 继续会话。",
      annotations: {
        title: "Close Worker",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workerId"],
        properties: {
          workerId: {
            type: "string",
            description: "要关闭的 worker ID（来自 worker_create 或 worker_discover）。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_request",
      description:
        "向指定 worker 发送任务或后续消息（若已关闭且支持恢复，会自动续接会话）。" +
        `默认最多等待 ${defaultWaitMs / 1000} 秒返回报告（waitMs 设为 0 立即返回并在后台执行）；` +
        "若返回 timedOut 或报告含 nextOffset 用 worker_output 继续，返回 needsResponse 时向用户确认后用 worker_response 回复。",
      annotations: {
        title: "Send Request to Worker",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workerId", "message"],
        properties: {
          workerId: {
            type: "string",
            description: "目标 worker ID（来自 worker_create 或 worker_discover）。",
          },
          message: {
            type: "string",
            description: "发给 worker 的任务说明或后续消息。worker 看不到当前对话历史，首次派发时请写清目标、相关文件路径、约束和交付要求。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `最多等待的毫秒数（默认 ${defaultWaitMs}）；传 0 立即返回并在后台执行。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_response",
      description:
        "回复 worker 返回 needsResponse: true 时的待处理请求（pendingRequests），用于权限审批（kind=\"permission\"）、表单提问（kind=\"form\"）和 URL 确认（kind=\"url\"）。" +
        `回复前先向用户确认；回复后默认最多等待 ${defaultWaitMs / 1000} 秒返回后续结果（waitMs 设为 0 立即返回）。`,
      annotations: {
        title: "Respond to Worker Request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workerId", "action"],
        properties: {
          workerId: {
            type: "string",
            description: "存在待处理请求的 worker ID。",
          },
          action: {
            type: "string",
            enum: [...responseActions],
            description: "accept：同意权限、提交表单或确认 URL；decline：拒绝；cancel：取消。",
          },
          requestId: {
            type: "string",
            description: "待回复的 pendingRequests[].requestId；仅一条请求时可省略，多条时必填。",
          },
          optionId: {
            type: "string",
            description: "仅 kind=\"permission\" 且 action 不为 cancel 时可用：指定 pendingRequests[].options[].optionId（省略时默认单次允许或拒绝）。",
          },
          content: {
            type: "object",
            additionalProperties: true,
            description: "仅 kind=\"form\" 且 action=\"accept\" 时可用：按 pendingRequests[].schema.properties 填写的答案对象（字段值支持字符串、数字、布尔或字符串数组）。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `回复后最多等待的毫秒数（默认 ${defaultWaitMs}）；传 0 立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_output",
      description:
        "获取指定 worker 最新一轮的执行报告：仍在运行时等待其完成（也可能返回 timedOut 或 needsResponse），已结束则立即返回；报告含 nextOffset 时传入 offset 翻页续读。",
      annotations: {
        title: "Get Worker Output",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workerId"],
        properties: {
          workerId: {
            type: "string",
            description: "要等待或读取报告的 worker ID。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "报告字符偏移量（默认 0）；翻页续读时传上次返回的 nextOffset。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `任务仍在运行时最多等待的毫秒数（默认 ${defaultWaitMs}）；已结束或翻页时立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_discover",
      description:
        "查询可用 backend、当前会话已有 worker 的状态，或指定 backend 可选的模型与思考力度。" +
        "默认（target=\"overview\"）返回可用 backend 与已有 worker；仅需确认模型或思考力度可选值时再查 target=\"models\"（耗时较长）。",
      annotations: {
        title: "Discover Workers, Backends & Models",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          target: {
            type: "string",
            enum: [...discoverTargets],
            description: "查询范围，默认 \"overview\"（同时返回 backends 与 workers）；\"workers\" 查全部或单个 worker 状态；\"backends\" 查可用 backend 列表；\"models\" 查指定 backend 的可选模型与思考力度。",
          },
          workerId: {
            type: "string",
            description: "仅 target=\"workers\" 可用：指定单个 worker ID；省略时列出全部。",
          },
          backend: {
            type: "string",
            description: availableIds
              ? `仅 target="models" 可用（${modelsBackendHint}）：目标代理程序名称，支持常见别名；可用：${availableIds}。`
              : `仅 target="models" 可用（${modelsBackendHint}）：目标代理程序名称，支持常见别名。`,
          },
          model: {
            type: "string",
            description: "仅 target=\"models\" 可用：指定模型以查询该模型支持的思考力度选项。",
          },
          workspace,
        },
      },
    },
  ];
}

export function buildWorkspaceMcpTools(workspaceBound = false) {
  const workspace = workspaceProperty(workspaceBound);
  return [
    {
      name: "workspace_mcp_discover",
      description:
        "查看工作区 .pbot/mcp.json 中统一注册的 MCP 服务列表；传入 server 时按需连接该服务并返回其全部工具及参数 schema。",
      annotations: {
        title: "Discover Workspace MCP Servers & Tools",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          server: {
            type: "string",
            description: "目标 MCP 服务名（来自 .pbot/mcp.json 的键名）；省略时仅列出已注册服务摘要。",
          },
          workspace,
        },
      },
    },
    {
      name: "workspace_mcp_call",
      description:
        "调用工作区 .pbot/mcp.json 中指定 MCP 服务的工具（首次调用按需连接并复用连接，配置变更自动热更新）。" +
        "不确定工具名或参数 schema 时，先用 workspace_mcp_discover(server) 查询。",
      annotations: {
        title: "Call Workspace MCP Tool",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["server", "tool"],
        properties: {
          server: {
            type: "string",
            description: "目标 MCP 服务名（来自 .pbot/mcp.json）。",
          },
          tool: {
            type: "string",
            description: "要调用的下游 MCP 工具名称。",
          },
          arguments: {
            type: "object",
            additionalProperties: true,
            description: "传递给下游 MCP 工具的参数对象，省略时为空对象。",
          },
          workspace,
        },
      },
    },
  ];
}

export const pbotWorkerTools = buildPbotWorkerTools();

export function defaultWorkerDirectory(): string {
  if (process.env.PBOT_MCP_AGENT_DIR) return process.env.PBOT_MCP_AGENT_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "subagents");
  return join(homedir(), ".pbot/subagents");
}

function isKnownWorkerTool(name: string): name is McpWorkerToolName {
  return (mcpWorkerToolNames as readonly string[]).includes(name);
}

function isKnownTool(name: string): name is AllMcpToolName {
  return (allMcpToolNames as readonly string[]).includes(name);
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
    const rawTool = typeof parsed.tool === "string" ? parsed.tool : undefined;
    const resolved = rawTool ? (isKnownWorkerTool(rawTool) ? rawTool : shortToolMap[rawTool]) : undefined;
    requireThat(resolved, `JSON 形式需包含有效 tool 字段（${mcpWorkerToolNames.join(", ")}），或使用 /pbot worker <工具名> <JSON>。`);
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "tool"));
    return { tool: resolved, args: rest };
  }
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();
  const tool = isKnownWorkerTool(verb) ? verb : shortToolMap[verb];
  requireThat(tool, `未知 worker 命令：${verb}（支持：overview | status | backends | models | create | request | response | output | close | discover）。`);
  if (!rest) return { tool, args: {} };
  const parsed: unknown = JSON.parse(rest);
  requireThat(object(parsed), `${tool} 的参数必须是 JSON 对象。`);
  return { tool, args: parsed };
}

function rejectUnknownParams(tool: AllMcpToolName, rawArgs: Record<string, unknown>) {
  const allowed = toolParams[tool];
  const unknown = Object.entries(rawArgs)
    .filter(([key, value]) => value !== undefined && !allowed.has(key))
    .map(([key]) => key);
  requireThat(unknown.length === 0, `未知参数：${unknown.join(", ")}（${tool} 可用参数：${[...allowed].join(", ")}）。`);
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
    const valid = typeof entry === "string"
      || (typeof entry === "number" && Number.isFinite(entry))
      || typeof entry === "boolean"
      || (Array.isArray(entry) && entry.every(item => typeof item === "string"));
    requireThat(valid, `参数 ${key}.${field} 必须是字符串、数字、布尔值或字符串数组。`);
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

  private resolveBackend(rawArgs: Record<string, unknown>, commands: AcpCommands | undefined, allowDefault: boolean): string {
    const raw = asString(rawArgs, "backend") ?? (allowDefault ? this.#defaultBackend : undefined);
    requireThat(raw, `缺少必填参数：backend（请指定目标程序：${knownAcpBackends(commands).join(", ")}）。`);
    const backend = canonicalAcpBackend(raw, commands);
    requireThat(isAcpBackend(backend), "无效的 backend 名称：" + raw);
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

  async toolDefinitions() {
    let commands: AcpCommands | undefined;
    let includeWorkspaceMcp = true;
    try {
      const root = await this.resolveWorkspace();
      const configuration = await readWorkspaceConfig(root);
      if (configuration.enabled) {
        commands = configuration.acp;
        includeWorkspaceMcp = workspaceFeatures(configuration).mcp;
      }
    } catch { /* Fall back to registered built-in harnesses when cwd is outside an enabled workspace. */ }
    const defaultBackend = this.#defaultBackend ? canonicalAcpBackend(this.#defaultBackend, commands) : undefined;
    const workspaceBound = Boolean(process.env.CLAUDE_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT);
    return [
      ...buildPbotWorkerTools(commands, defaultBackend, workspaceBound),
      ...(includeWorkspaceMcp ? buildWorkspaceMcpTools(workspaceBound) : []),
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
      requireThat(!this.#closed, "Personal Bot MCP 服务已关闭。");
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
        const page = await service.read(workerId, owner, targetCycle.cycleId, offset, reportPageSize);
        return { settled: true, ...presentWorker(page) };
      }
      if (terminalWithoutCycle || failedBeforeCycle) {
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

  async callTool(name: string, rawArgs: unknown, progress?: ProgressReporter): Promise<unknown> {
    requireThat(isKnownTool(name), `未知工具：${name}（可用：${allMcpToolNames.join(", ")}）。`);
    requireThat(object(rawArgs), "工具参数必须是对象。");
    rejectUnknownParams(name, rawArgs);
    const { root, configuration, host, service, owner } = await this.workspace(asString(rawArgs, "workspace"));

    switch (name) {
      case "workspace_mcp_discover": {
        requireThat(workspaceFeatures(configuration).mcp, `工作区统一 MCP 功能已在 ${configuration.path} 中停用（features.mcp: false）。`);
        const server = asString(rawArgs, "server");
        return this.#bridge.discover(root, server);
      }
      case "workspace_mcp_call": {
        requireThat(workspaceFeatures(configuration).mcp, `工作区统一 MCP 功能已在 ${configuration.path} 中停用（features.mcp: false）。`);
        const server = asString(rawArgs, "server", true)!;
        const tool = asString(rawArgs, "tool", true)!;
        const toolArgs = rawArgs.arguments === undefined ? {} : rawArgs.arguments;
        requireThat(object(toolArgs), "参数 arguments 必须是 JSON 对象。");
        return this.#bridge.call(root, server, tool, toolArgs);
      }
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
        const rawAction = asString(rawArgs, "action", true)!;
        requireThat((responseActions as readonly string[]).includes(rawAction),
          `参数 action 无效：${rawAction}（可用：${responseActions.join(", ")}）。`);
        const action = rawAction as AcpElicitationAction;
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
        requireThat((discoverTargets as readonly string[]).includes(rawTarget),
          `参数 target 无效：${rawTarget}（可用：${discoverTargets.join(", ")}）。`);
        const target = rawTarget as DiscoverTarget;
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
  }

  async close(preserve = false): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#services.values()];
    this.#services.clear();
    await Promise.allSettled([
      this.#bridge.close(),
      ...entries.map(({ service, owner }) => service.close(owner, preserve)),
    ]);
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
