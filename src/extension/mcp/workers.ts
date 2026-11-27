import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../../common/json.js";
import { isAcpBackend, requireThat } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import { AcpWorkerHost } from "../../integrations/acp/agents.js";
import { canonicalAcpBackend, inspectAcpBackends, knownAcpBackends } from "../../integrations/acp/launch.js";
import {
  mcpWorkerToolNames,
  type AcpCommands,
  type AcpElicitationAction,
  type AcpElicitationContent,
  type AcpModelSelection,
  type McpWorkerToolName,
} from "../../model/acp.js";
import { workspaceMcpToolNames, type WorkspaceMcpToolName } from "../../model/workspace-mcp.js";
import type { AgentCycle, AgentOwner, AgentView } from "../../model/agent.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { readWorkspaceHistory, searchWorkspaceHistory } from "../../services/history/history-query.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { isHistoryHost, isSummaryDimension } from "../../storage/history-format.js";
import { WorkspaceMcpBridge } from "./bridge.js";

const protocolVersion = "2025-03-26";
const readyTimeoutMs = 45_000;
const defaultWaitMs = 50_000;
const maxWaitMs = 600_000;
const reportPageSize = 16_000;
const progressIntervalMs = 5_000;

const responseActions = ["accept", "decline", "cancel"] as const;
const discoverTargets = ["overview", "workers", "backends", "models"] as const;
type DiscoverTarget = typeof discoverTargets[number];

const mcpHistoryToolNames = ["history_search", "history_read"] as const;
type McpHistoryToolName = typeof mcpHistoryToolNames[number];
type AllMcpToolName = McpWorkerToolName | WorkspaceMcpToolName | McpHistoryToolName;
const allMcpToolNames: readonly AllMcpToolName[] = [...mcpWorkerToolNames, ...workspaceMcpToolNames, ...mcpHistoryToolNames];

const toolParams: Record<AllMcpToolName, ReadonlySet<string>> = {
  worker_create: new Set(["backend", "model", "thinking", "cwd", "workspace"]),
  worker_close: new Set(["workerId", "workspace"]),
  worker_request: new Set(["workerId", "message", "waitMs", "workspace"]),
  worker_response: new Set(["workerId", "action", "requestId", "optionId", "content", "waitMs", "workspace"]),
  worker_output: new Set(["workerId", "offset", "waitMs", "workspace"]),
  worker_discover: new Set(["target", "workerId", "backend", "model", "workspace"]),
  workspace_mcp_discover: new Set(["server", "workspace"]),
  workspace_mcp_call: new Set(["server", "tool", "arguments", "workspace"]),
  history_search: new Set(["host", "dimension", "query", "sessionId", "from", "to", "offset", "limit", "workspace"]),
  history_read: new Set(["id", "host", "offset", "limit", "childrenOffset", "workspace"]),
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

export const mcpWorkerOnlyInstructions =
  "提供跨助手协作能力（worker_*）：可启动并调度其他外部 AI 助手在当前工作区中独立执行任务，适用于用户指定其他助手、需要特定模型或思考深度、获取独立审查/第二意见，或并行处理子任务。不需要借助其他助手时，优先自行完成或使用当前内置子代理。\n" +
  "使用流程：用 worker_create 启动目标助手（或用 worker_discover 复用已有会话）→ 用 worker_request 派发任务或继续追问 → 任务完成后可用 worker_close 结束会话。后台等待、超时续等（timedOut）或长结果翻页（nextOffset）用 worker_output；助手请求授权或提问（needsResponse）时，先向用户确认，再用 worker_response 回复。";

export const mcpInstructions =
  "提供三类能力：\n" +
  "1. 跨助手协作（worker_*）：启动并调度其他外部 AI 助手在当前工作区中独立执行任务，适用于用户指定其他助手、需要特定模型或思考深度、获取独立审查/第二意见，或并行处理子任务。不需要借助其他助手时，优先自行完成或使用当前内置子代理。使用流程：worker_create 启动助手（或 worker_discover 复用已有会话）→ worker_request 派发任务或追问 → 完成后 worker_close 结束；后台等待、超时续等（timedOut）或长结果翻页（nextOffset）用 worker_output；返回 needsResponse 时先向用户确认，再用 worker_response 回复。\n" +
  "2. 工作区共享外部工具（workspace_mcp_*）：发现并调用当前工作区接入的外部工具服务与数据源（可与当前环境原生工具同时使用）。先用 workspace_mcp_discover 查看可用服务与工具说明，再用 workspace_mcp_call 调用。\n" +
  "3. 跨宿主历史查询（history_search / history_read）：只读检索当前工作区在 Pi、dsh、Claude Code、Antigravity 等宿主中记录的历史问答与摘要归档。";

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
      ? `当前可用助手：${availableText}；暂不可用：${unavailableText}。`
      : `当前可用助手：${availableText}。`
    : `当前无可用外部助手（暂不可用：${unavailableText}）。`;
  const availableIds = available.map(item => item.backend).join("、");
  return { overview, availableIds };
}

function workspaceProperty(workspaceBound: boolean) {
  return {
    type: "string",
    description: workspaceBound
      ? "目标工作区根目录的绝对路径；默认使用当前工作区，通常省略。"
      : "目标工作区根目录的绝对路径（如上下文中提供了 workspaceRoot 则传该路径）；请显式传入。",
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
        "启动一个独立的外部 AI 助手会话（worker），用于将任务委派给其他助手或指定模型/思考深度来独立处理（如按用户要求切换助手、获取独立审查或第二意见、并行分担子任务）。" +
        "本工具仅建立会话并返回 workerId，随后通过 worker_request 发送具体任务。不需要借助其他助手时，优先自行完成或使用当前内置子代理。\n" +
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
            description: "要启动的外部助手标识（不区分大小写，支持常见别名，如 claude-code、agy）。",
          },
          model: {
            type: "string",
            description: "仅用户明确要求特定模型时指定（支持模型 ID、显示名或 provider/model，不区分大小写）；不确定可用值时先用 worker_discover(target=\"models\") 查询；不填则使用该助手默认模型。",
          },
          thinking: {
            type: "string",
            description: "仅用户明确要求思考深度时指定（如 low / medium / high / xhigh / max，不区分大小写）；不填则使用默认设置。",
          },
          cwd: {
            type: "string",
            description: "助手执行任务时的工作目录（绝对路径或相对工作区的路径），默认为当前工作区根目录。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_close",
      description:
        "结束不再需要的外部助手会话并释放资源。若该助手支持会话恢复，后续仍可直接用 worker_request 在原上下文中继续对话。",
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
            description: "要结束的助手会话 ID（来自 worker_create 或 worker_discover）。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_request",
      description:
        "向指定的外部助手派发任务，或在同一上下文中追问与补充要求，并获取执行结果（已关闭但支持恢复的会话会自动续接）。" +
        `默认最多等待 ${defaultWaitMs / 1000} 秒返回结果；将 waitMs 设为 0 可立即返回并转入后台执行，适合耗时任务或多助手并行。` +
        "若返回 timedOut 或结果含 nextOffset，用 worker_output 继续等待或翻页；若返回 needsResponse，先向用户确认再用 worker_response 回复。",
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
            description: "目标助手会话 ID（来自 worker_create 或 worker_discover）。",
          },
          message: {
            type: "string",
            description: "要发送的任务说明或追问内容。外部助手看不到你与用户的对话历史，首次派发时请写清背景、目标、相关文件路径、约束条件和期望产出。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `最多等待结果的毫秒数（默认 ${defaultWaitMs}）；设为 0 可立即返回并在后台执行。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_response",
      description:
        "当外部助手在执行过程中暂停并请求确认或补充信息（返回 needsResponse: true）时，向其提交决定以继续执行。" +
        "支持三类请求：操作授权（kind=\"permission\"）、问答表单（kind=\"form\"）和链接确认（kind=\"url\"）。" +
        `提交前先向用户确认；提交后默认最多等待 ${defaultWaitMs / 1000} 秒返回后续结果（waitMs 设为 0 立即返回）。`,
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
            description: "等待回复的助手会话 ID。",
          },
          action: {
            type: "string",
            enum: [...responseActions],
            description: "处理方式：accept 表示同意授权、提交表单回答或确认链接；decline 表示拒绝；cancel 表示取消本次请求。",
          },
          requestId: {
            type: "string",
            description: "要回复的请求 ID（来自 pendingRequests[].requestId）；仅一条待处理请求时可省略，多条时必填。",
          },
          optionId: {
            type: "string",
            description: "仅授权请求（kind=\"permission\"）且 action 不为 cancel 时可用：指定选项 ID（来自 pendingRequests[].options[].optionId），省略时默认单次允许或拒绝。",
          },
          content: {
            type: "object",
            additionalProperties: true,
            description: "仅表单提问（kind=\"form\"）且 action=\"accept\" 时可用：按 pendingRequests[].schema.properties 填写的回答对象（值为字符串、数字、布尔值或字符串数组）。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `提交回复后最多等待后续结果的毫秒数（默认 ${defaultWaitMs}）；设为 0 立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_output",
      description:
        "获取或等待外部助手的最新执行结果。用于收取后台任务的产出、在等待超时（timedOut）后继续等待，或在长结果分页（含 nextOffset）时读取后续内容。" +
        "任务仍在运行时会等待其完成（也可能返回 timedOut 或 needsResponse），已结束则立即返回。",
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
            description: "要等待或获取结果的助手会话 ID。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "结果读取起始位置（默认 0）；翻页读取剩余内容时传入上次返回的 nextOffset。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `任务仍在运行时最多等待的毫秒数（默认 ${defaultWaitMs}）；任务已结束或翻页读取时会立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_discover",
      description:
        "了解当前可以委派哪些外部助手、查看已有助手会话的运行状态以便复用，或查询某个助手支持的模型与思考深度选项。" +
        "默认（target=\"overview\"）同时返回可用助手与已有会话；仅在需要核对模型或思考深度可选值时再查 target=\"models\"（耗时较长）。",
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
            description: "查询范围，默认 \"overview\"（同时返回可用助手与已有会话）；\"workers\" 查全部或单个会话状态；\"backends\" 查可用助手列表；\"models\" 查指定助手支持的模型与思考深度。",
          },
          workerId: {
            type: "string",
            description: "仅 target=\"workers\" 可用：指定单个助手会话 ID；不填则列出全部。",
          },
          backend: {
            type: "string",
            description: availableIds
              ? `仅 target="models" 可用（${modelsBackendHint}）：目标外部助手标识，支持常见别名；当前可用：${availableIds}。`
              : `仅 target="models" 可用（${modelsBackendHint}）：目标外部助手标识，支持常见别名。`,
          },
          model: {
            type: "string",
            description: "仅 target=\"models\" 可用：指定模型以查看该模型支持的思考深度选项。",
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
        "发现当前工作区共享的外部工具服务（MCP）及其可用工具。不传 server 时列出可用服务；传入 server 时返回该服务提供的工具清单与参数说明。",
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
            description: "目标工具服务名称；不填时列出工作区全部可用服务。",
          },
          workspace,
        },
      },
    },
    {
      name: "workspace_mcp_call",
      description:
        "调用当前工作区共享的外部工具服务（MCP）中的指定工具，用于访问工作区接入的外部能力与数据源。" +
        "不确定工具名或参数格式时，先用 workspace_mcp_discover(server) 查询。",
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
            description: "目标工具服务名称（可通过 workspace_mcp_discover 获取）。",
          },
          tool: {
            type: "string",
            description: "要调用的工具名称。",
          },
          arguments: {
            type: "object",
            additionalProperties: true,
            description: "传给目标工具的参数对象，不填则为空对象。",
          },
          workspace,
        },
      },
    },
  ];
}

export function buildHistoryMcpTools(workspaceBound = false) {
  const workspace = workspaceProperty(workspaceBound);
  return [
    {
      name: "history_search",
      description:
        "搜索当前工作区跨宿主（pi、dsh、claude、antigravity 等）的历史问答与摘要归档。省略 query 时列出各会话；传入 query 按不区分大小写的连续关键词匹配原文与摘要。",
      annotations: {
        title: "Search Workspace History",
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
          host: {
            type: "string",
            description: "可选来源筛选（如 pi、dsh、claude、antigravity）；省略查全部宿主。",
          },
          dimension: {
            type: "string",
            description: "可选范围筛选：raw 表示仅搜原文，或指定摘要维度（如 session）；省略查全部原文与维度摘要。",
          },
          query: {
            type: "string",
            description: "不区分大小写的连续关键词；省略时列出各会话（或指定维度摘要）。",
          },
          sessionId: {
            type: "string",
            description: "限定在指定原始会话 ID 内搜索。",
          },
          from: {
            type: "string",
            description: "ISO 日期或时间下界。",
          },
          to: {
            type: "string",
            description: "ISO 日期或时间上界。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "匹配结果偏移，默认 0。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "最多返回条数（1–50），默认 20。",
          },
          workspace,
        },
      },
    },
    {
      name: "history_read",
      description:
        "按节点 id 读取当前工作区历史归档的正文与上下级节点（session、summary、exchange）。正文过长时用 nextOffset 续读，子节点过多时用 nextChildrenOffset 续读。",
      annotations: {
        title: "Read Workspace History Node",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "history_search 或上下级返回的节点 id。",
          },
          host: {
            type: "string",
            description: "跨来源 ID 冲突时显式指定来源宿主。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "正文字符偏移，默认 0。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 24000,
            description: "正文字符数（1–24000），默认 12000。",
          },
          childrenOffset: {
            type: "integer",
            minimum: 0,
            description: "子节点列表偏移，默认 0；续读传上页 nextChildrenOffset。",
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
  readonly #nativeWorkspaceMcp: boolean;
  readonly #nativeHistory: boolean;
  #closed = false;

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
    const workspaceBound = Boolean(process.env.CLAUDE_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT);
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
        requireThat(!this.#nativeWorkspaceMcp, "当前宿主已原生挂载工作区 .pbot/mcp.json 服务，请直接调用对应原生 MCP 工具，勿重复经由 workspace_mcp_* 桥接。");
        requireThat(workspaceFeatures(configuration).mcp, `工作区统一 MCP 功能已在 ${configuration.path} 中停用（features.mcp: false）。`);
        const server = asString(rawArgs, "server");
        return this.#bridge.discover(root, server);
      }
      case "workspace_mcp_call": {
        requireThat(!this.#nativeWorkspaceMcp, "当前宿主已原生挂载工作区 .pbot/mcp.json 服务，请直接调用对应原生 MCP 工具，勿重复经由 workspace_mcp_* 桥接。");
        requireThat(workspaceFeatures(configuration).mcp, `工作区统一 MCP 功能已在 ${configuration.path} 中停用（features.mcp: false）。`);
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
        if (hostFilter !== undefined) requireThat(isHistoryHost(hostFilter), "无效的 host 来源：" + hostFilter);
        const dimension = asString(rawArgs, "dimension");
        if (dimension !== undefined) requireThat(isSummaryDimension(dimension), "无效的 dimension：" + dimension);
        const query = asString(rawArgs, "query");
        const sessionId = asString(rawArgs, "sessionId");
        const from = asString(rawArgs, "from");
        const to = asString(rawArgs, "to");
        const offset = asInt(rawArgs, "offset", 0, 10_000_000) ?? 0;
        const limit = asInt(rawArgs, "limit", 1, 50) ?? 20;
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
        if (hostFilter !== undefined) requireThat(isHistoryHost(hostFilter), "无效的 host 来源：" + hostFilter);
        const offset = asInt(rawArgs, "offset", 0, 10_000_000) ?? 0;
        const limit = asInt(rawArgs, "limit", 1, 24000) ?? 12000;
        const childrenOffset = asInt(rawArgs, "childrenOffset", 0, 10_000_000) ?? 0;
        return { node: readWorkspaceHistory(root, id, offset, limit, childrenOffset, hostFilter) };
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
