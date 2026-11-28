import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { inspectAcpBackends } from "../../integrations/acp/launch.js";
import { historyPageLimits } from "../../model/history.js";
import { acpElicitationActions, type AcpCommands } from "../../model/acp.js";

export const defaultWaitMs = 50_000;
export const maxWaitMs = 600_000;
export const discoverTargets = ["overview", "workers", "backends", "models"] as const;

function formatBackendItem(entry: ReturnType<typeof inspectAcpBackends>[number], defaultBackend?: string): string {
  const tags: string[] = [];
  if (entry.label) tags.push(entry.label);
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
      ? "工作区根目录绝对路径；默认当前工作区，通常省略。"
      : "目标工作区根目录绝对路径；请传入环境中的 workspaceRoot。",
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
      name: "worker_create" as const,
      description:
        "启动独立的外部助手会话并返回 workerId（不发送任务，随后用 worker_request 派发）。未指定其他助手或特定模型时，优先自行完成或使用当前内置子代理。\n" +
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
            description: "目标外部助手标识（不区分大小写，支持常见别名如 claude-code、agy）。",
          },
          model: {
            type: "string",
            description: "目标模型（模型 ID、显示名或 provider/model，不区分大小写）；未明确指定时省略以用默认模型，不确定可选值时先查 worker_discover(target=\"models\")。",
          },
          thinking: {
            type: "string",
            description: "思考深度（如 low / medium / high / xhigh / max，不区分大小写）；未明确指定时省略以用默认设置。",
          },
          cwd: {
            type: "string",
            description: "执行目录（绝对路径或相对工作区路径），默认工作区根目录。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_close" as const,
      description:
        "结束外部助手会话并释放进程。若该会话支持恢复（capabilities.resume），后续仍可直接用 worker_request 续接。",
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
            description: "助手会话 ID（来自 worker_create 或 worker_discover）。",
          },
          workspace,
        },
      },
    },
    {
      name: "worker_request" as const,
      description:
        "向外部助手派发任务或在同一上下文中追问（已关闭且支持恢复的会话会自动续接）。" +
        `默认最多等待 ${defaultWaitMs / 1000} 秒（waitMs 设为 0 可立即转后台并行）；返回 timedOut 或 nextOffset 用 worker_output，返回 needsResponse 先向用户确认再用 worker_response。`,
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
            description: "助手会话 ID（来自 worker_create 或 worker_discover）。",
          },
          message: {
            type: "string",
            description: "任务说明或追问内容。外部助手看不到当前会话历史，首次派发需写清背景、目标、相关文件路径、约束和期望产出。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `最多等待毫秒数（默认 ${defaultWaitMs}）；0 表示立即返回转后台执行。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_response" as const,
      description:
        "回复外部助手暂停时发出的待处理请求（needsResponse: true），支持操作授权、表单问答与链接确认。" +
        `提交前先向用户确认；提交后默认等待最多 ${defaultWaitMs / 1000} 秒返回后续结果。`,
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
            enum: [...acpElicitationActions],
            description: "accept 同意/提交表单/确认链接；decline 拒绝；cancel 取消请求。",
          },
          requestId: {
            type: "string",
            description: "请求 ID（pendingRequests[].requestId）；仅一条待处理请求时可省略，多条时必填。",
          },
          optionId: {
            type: "string",
            description: "仅 permission 请求且 action≠cancel 时可用：指定 pendingRequests[].options[].optionId，省略则按 action 单次允许或拒绝。",
          },
          content: {
            type: "object",
            additionalProperties: true,
            description: "仅 form 请求且 action=\"accept\" 时可用：按 pendingRequests[].schema.properties 填写回答对象（值为字符串、数字、布尔值或字符串数组）。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `提交后最多等待毫秒数（默认 ${defaultWaitMs}）；0 表示立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_output" as const,
      description:
        "获取或等待外部助手的最新结果，用于收取后台产出、timedOut 后继续等待，或按 nextOffset 分页续读。任务已结束时立即返回，运行中最多等待 waitMs。",
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
            description: "助手会话 ID。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "读取起始位置（默认 0）；翻页续读时传上次返回的 nextOffset。",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: maxWaitMs,
            description: `运行中最多等待毫秒数（默认 ${defaultWaitMs}）；已结束或翻页时立即返回。`,
          },
          workspace,
        },
      },
    },
    {
      name: "worker_discover" as const,
      description:
        "查询可用外部助手、已有会话状态，或某个助手支持的模型与思考深度。默认（overview）返回可用助手与已有会话；仅需核对模型或思考深度可选值时再查 models（需启动探测，耗时较长）。",
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
            description: "overview（默认，可用助手与已有会话）、workers（全部或单个会话状态）、backends（可用助手）、models（指定助手的模型与思考深度）。",
          },
          workerId: {
            type: "string",
            description: "仅 target=\"workers\" 可用：指定单个会话 ID，省略列全部。",
          },
          backend: {
            type: "string",
            description: availableIds
              ? `仅 target="models" 可用（${modelsBackendHint}）：目标助手标识，支持别名；当前可用：${availableIds}。`
              : `仅 target="models" 可用（${modelsBackendHint}）：目标助手标识，支持别名。`,
          },
          model: {
            type: "string",
            description: "仅 target=\"models\" 可用：指定模型以查看其支持的思考深度选项。",
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
      name: "workspace_mcp_discover" as const,
      description:
        "查询当前工作区共享 MCP 服务（.pbot/mcp.json）。省略 server 列出服务；传入 server 返回其工具列表与参数说明。",
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
            description: "服务名称；省略列出工作区全部已配置服务。",
          },
          workspace,
        },
      },
    },
    {
      name: "workspace_mcp_call" as const,
      description:
        "调用工作区共享 MCP 服务中的指定工具。不确定工具名或参数时先用 workspace_mcp_discover(server) 查询。",
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
            description: "服务名称（来自 workspace_mcp_discover）。",
          },
          tool: {
            type: "string",
            description: "工具名称。",
          },
          arguments: {
            type: "object",
            additionalProperties: true,
            description: "传给目标工具的参数对象，默认空对象。",
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
      name: "history_search" as const,
      description:
        "搜索当前工作区跨宿主历史问答与摘要归档（不含工具调用日志）。省略 query 列出各会话或指定维度摘要；传入 query 按不区分大小写的连续关键词匹配。",
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
            description: "来源宿主筛选（如 pi、dsh、claude、antigravity、codex、qoder）；省略查全部。",
          },
          dimension: {
            type: "string",
            description: "范围筛选：raw 仅原文，或指定摘要维度（如 monthly、session）；省略查全部。",
          },
          query: {
            type: "string",
            description: "连续关键词（不区分大小写）；省略列会话或指定维度摘要。",
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
            description: "结果偏移，默认 0。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: historyPageLimits.search.max,
            description: `返回条数（1–${historyPageLimits.search.max}），默认 ${historyPageLimits.search.default}。`,
          },
          workspace,
        },
      },
    },
    {
      name: "history_read" as const,
      description:
        "按节点 id 读取历史正文与上下级（可从 monthly 汇总下钻至 session 摘要和 exchange 原文）。正文分页传 nextOffset，子节点分页传 nextChildrenOffset。",
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
            description: "节点 id（来自 history_search 或上下级）。",
          },
          host: {
            type: "string",
            description: "跨宿主 id 冲突时指定来源宿主。",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "正文字符偏移，默认 0；续读传上次 nextOffset。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: historyPageLimits.read.max,
            description: `正文字符数（1–${historyPageLimits.read.max}），默认 ${historyPageLimits.read.default}。`,
          },
          childrenOffset: {
            type: "integer",
            minimum: 0,
            description: "子节点偏移，默认 0；续读传上次 nextChildrenOffset。",
          },
          workspace,
        },
      },
    },
  ];
}

export const pbotWorkerTools = buildPbotWorkerTools();

const definitions = [...pbotWorkerTools, ...buildWorkspaceMcpTools(), ...buildHistoryMcpTools()];
type ToolFields = { name: typeof definitions[number]["name"]; fields: Set<string> };
const toolsByName = new Map<string, ToolFields>(definitions.map(({ name, inputSchema }) =>
  [name, { name, fields: new Set(Object.keys(inputSchema.properties)) }]));

export function parseMcpToolCall(name: string, args: unknown) {
  const tool = toolsByName.get(name);
  requireThat(tool, `未知工具：${name}（可用：${[...toolsByName.keys()].join(", ")}）。`);
  requireThat(object(args), "工具参数必须是对象。");
  const unknown = Object.entries(args)
    .filter(([key, value]) => value !== undefined && !tool.fields.has(key))
    .map(([key]) => key);
  requireThat(unknown.length === 0, `未知参数：${unknown.join(", ")}（${name} 可用参数：${[...tool.fields].join(", ")}）。`);
  return { name: tool.name, args };
}
