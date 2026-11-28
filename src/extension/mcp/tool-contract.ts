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
      name: "worker_create" as const,
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
      name: "worker_close" as const,
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
      name: "worker_request" as const,
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
      name: "worker_response" as const,
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
            enum: [...acpElicitationActions],
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
      name: "worker_output" as const,
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
      name: "worker_discover" as const,
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
      name: "workspace_mcp_discover" as const,
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
      name: "workspace_mcp_call" as const,
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
      name: "history_search" as const,
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
            description: "可选范围筛选：raw 表示仅搜原文，或指定摘要维度（如 monthly、session）；省略查全部原文与维度摘要。",
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
            maximum: historyPageLimits.search.max,
            description: `最多返回条数（1–${historyPageLimits.search.max}），默认 ${historyPageLimits.search.default}。`,
          },
          workspace,
        },
      },
    },
    {
      name: "history_read" as const,
      description:
        "按节点 id 读取当前工作区历史归档的正文与上下级节点（monthly、session、summary、exchange），支持从月度汇总下钻至单会话摘要与原始问答。正文过长时用 nextOffset 续读，子节点过多时用 nextChildrenOffset 续读。",
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
            maximum: historyPageLimits.read.max,
            description: `正文字符数（1–${historyPageLimits.read.max}），默认 ${historyPageLimits.read.default}。`,
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
