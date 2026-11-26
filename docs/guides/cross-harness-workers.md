# 跨 Harness 专家调度（`worker_*`）

Personal Bot 将跨 Harness 专家调度统一为单一的 stdio MCP 服务（`lib/extension/mcp.js` / `pbot mcp`），对外暴露 6 个职责清晰、读写分离的 **`worker_*`** 工具，并在 Pi/dsh 中提供对应的 **`/pbot worker`** 命令。

## 与宿主原生 Subagent 互补

- **同宿主子任务与团队协作**：完全交给当前宿主的原生能力（例如 Claude 原生 `Agent`/团队、Antigravity 原生 `invoke_subagent`/`/swarm`、dsh 原生 `subagent`）。Personal Bot 不拦截、不覆盖、也不复制宿主原生 subagent 工具。
- **跨 Harness 专业分工**：当需要调用**另一个 Harness** 发挥其特长（例如在 Antigravity 中委派 Claude/Codex 编码，或在 Pi/dsh 中委派 Antigravity 探索、Claude 审查）时，通过 MCP 的 `worker_*` 工具经标准 ACP v1 协议创建并管理目标 Harness 的独立 worker。
- **路由分工偏好**：哪些任务优先交给哪个 Harness，由用户在工作区 `AGENTS.md` 或 `agents/coordinator.md` 中自然约定，由主会话协调者自主决策，不在代码中硬编码工作流引擎。

## 多宿主统一挂载方式

| 宿主 | 挂载方式 | 工具名 |
| --- | --- | --- |
| Pi | 扩展启用时通过 `pi.registerMcpServer("pbot", ...)` 自动挂载 | `mcp__pbot__worker_*`（及 `/pbot worker`） |
| dsh | 插件启用时通过 `@deepseek-ai/dsh-mcp-client` 自动挂载 | `mcp__pbot__worker_*`（及 `/pbot worker`） |
| Claude Code | 根 `.mcp.json` 自动挂载 `${CLAUDE_PLUGIN_ROOT}/lib/extension/mcp.js` | `worker_*` |
| Antigravity | 插件 `mcp_config.json` 自动挂载 `./lib/extension/mcp.js` | `worker_*` |
| Codex / Cursor / 其他 MCP 宿主 | 手动配置 stdio MCP 命令 `npx personal-bot@latest mcp`（或 `pbot mcp`） | `worker_*` |

## 6 个 MCP 工具契约

MCP 服务在 `initialize` 返回服务级流程说明 `instructions`，`tools/list` 根据已注册预设与当前工作区 `.pbot/config.json` 的 `acp` 配置动态探测本机可用 `backend`，为每个工具提供独立的严格 Schema 与 MCP `annotations`（读写与破坏性标记）：

| 工具 | 读写属性 | 必填参数 | 可选参数（均含 `workspace`） | 职责与行为 |
| --- | --- | --- | --- | --- |
| `worker_create` | 写 | `backend` | `model`, `thinking`, `cwd` | 创建并启动新 ACP worker，等待握手与模型/思考力度配置完成（非法值立即报错），返回 `idle` 态资源与 `capabilities.resume`（不发任务指令） |
| `worker_close` | 销毁写 | `workerId` | 无 | 停止并关闭 worker，释放进程并保留历史与周期报告（目标支持恢复时后续仍可由 `worker_request` 自动恢复） |
| `worker_request` | 主动写 | `workerId`, `message` | `waitMs` | 主动发送首轮任务、多轮追问或回合后问答回复（已关闭自动恢复）；默认同步等待 50s 返回报告（`waitMs: 0` 立即异步），遇到挂起交互立即返回 `needsResponse: true` |
| `worker_response` | 被动回复写 | `workerId`, `action` | `requestId`, `optionId`, `content`, `waitMs` | 回复 worker 执行中途发起的挂起请求（`pendingRequests[]`）：`action` 为 `accept` / `decline` / `cancel`；权限审批（`kind: "permission"`）可用 `optionId` 指定策略，问答/选择/表单输入（`kind: "form"`，含 Claude `AskUserQuestion`）用 `content` 提交键值答案，URL 确认（`kind: "url"`）直接用 `action`；默认回复后继续等待 50s |
| `worker_output` | **只读** | `workerId` | `offset`, `waitMs` | 获取最新一轮执行报告：运行中自动等待至结束（默认 50s，可返回 `timedOut` 或 `needsResponse`），已结束立即返回报告；超长报告（单页 16000 字符）含 `nextOffset` 时传 `offset` 立即翻页 |
| `worker_discover` | **只读** | 无 | `target`, `workerId`, `backend`, `model` | 统一只读发现：`target` 省略或 `"overview"` 即时返回本机 `backends` 与当前会话 `workers`；`"workers"` 查全部或单个 worker 状态；`"backends"` 查可用目标与权限策略；`"models"` 临时探测目标可选模型与思考力度（省略 `backend` 回退 `PBOT_HOST`） |

典型调用示例：

```json
// 1. 发现可用后端与当前会话 worker（本地即时）
worker_discover({})
// 或探测目标可选模型与思考力度
worker_discover({ "target": "models", "backend": "claude" })

// 2. 创建 worker（实时创建，返回 workerId 与生效 selection）
worker_create({ "backend": "codex" })
worker_create({ "backend": "claude", "model": "opus", "thinking": "high" })

// 3. 派发任务 / 多轮追问（已关闭自动恢复）
worker_request({ "workerId": "<workerId>", "message": "完成模块 A 并运行测试" })

// 4. 超时续等或长报告翻页
worker_output({ "workerId": "<workerId>" })
worker_output({ "workerId": "<workerId>", "offset": 16000 })

// 5. 回复中途挂起的权限审批或问答/表单（AskUserQuestion）
worker_response({ "workerId": "<workerId>", "action": "accept" })
worker_response({ "workerId": "<workerId>", "action": "accept", "content": { "question_0": "方案 B" } })

// 6. 关闭释放
worker_close({ "workerId": "<workerId>" })
```

在 Pi 与 dsh 聊天框中，也可直接以 `/pbot worker overview`、`/pbot worker status`、`/pbot worker backends`、`/pbot worker models claude`、`/pbot worker close <workerId>` 或 `/pbot worker create {"backend":"codex"}` 等命令操作当前会话的 worker（与该会话自动挂载的 MCP 服务共享同一会话归属）。

## 内置预设与任意自定义 ACP Harness

内置预设开箱即用，支持忽略大小写与常见别名（如 `Claude Code`→`claude`、`OpenAI Codex`→`codex`、`agy`→`antigravity`；工作区自定义同名项优先于内置别名），也可通过 `.pbot/config.json` 的 `acp` 字段覆盖命令或调整权限策略（详见[工作区配置](workspace-configuration.md#acp-harness-配置acp)）：

| 预设 `backend` | 常用名称 / 别名 | 默认入口 | 安装与认证 |
| --- | --- | --- | --- |
| `pi` | Pi | `pi-acp` | `npm install -g pi-acp`（另需 Pi）；运行 `pi` 完成登录与默认模型配置 |
| `dsh` | DeepSeek dsh | `dsh --profile acp` | `npm install -g @deepseek-ai/dsh@latest`；按 dsh 原生方式配置 profile |
| `claude` | Claude Code (`claude-code`) | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp`；在 Claude Code 完成登录或 API 配置 |
| `antigravity` | Google Antigravity (`agy`) | `agy acp` | 安装 Google Antigravity CLI（`agy`）并完成登录 |
| `codex` | OpenAI Codex (`openai-codex`, `codex-cli`) | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp`；在 Codex 完成登录或 API 配置 |
| 自定义名 | `.pbot/config.json` `acp.<name>` | 自定义命令 | 任意符合 ACP v1 的 stdio 程序，无需修改 Personal Bot 代码 |

从旧版 Codex 适配器迁移时，先执行 `npm uninstall -g @zed-industries/codex-acp`，再安装 `@agentclientprotocol/codex-acp`。两个包都提供 `codex-acp` 命令。

## 执行与安全边界

- **模型与配置独立**：ACP worker 使用目标 Harness 自己的认证、模型、工具与技能，不继承父宿主默认模型；省略 `model`/`thinking` 时沿用目标默认配置；显式指定时支持精确值、忽略大小写的显示名、唯一简名或多提供方格式 `provider/model`，非法值在 `worker_create` 阶段即时报错并列出可用值。
- **上下文注入**：对于标准 ACP v1 目标，若对端声明 `sessionCapabilities.systemPrompt` 则在建会话时 append 公共约定与 `general-purpose` 职责；否则在首轮消息前自动前置一次，后续轮次不重复。
- **权限与中途交互转发**：未配置 `acp.<name>.permission` 时默认沿用目标 Harness 原生权限策略，遇到 `session/request_permission` 时以 `ask` 转发给主会话；同时向对端声明 ACP `elicitation`（`form` 与 `url`）能力，使 Claude Code `AskUserQuestion`、MCP 表单采集与 URL 确认均通过统一的 `needsResponse: true` 与 `pendingRequests[]` 转发给主会话，确认后由 `worker_response` 回复。可在 `.pbot/config.json` 按目标配置 `"permission": "ask" | "allow" | "deny"`。
- **进程生命周期**：每个 worker 运行在独立进程组中；MCP 服务或宿主会话关闭时自动停止并回收所属 worker 进程组。
