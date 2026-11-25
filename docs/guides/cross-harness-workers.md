# 跨 Harness 专家调度（`pbot_worker`）

Personal Bot 将跨 Harness 专家调度统一为单一的 stdio MCP 服务（`lib/extension/mcp.js` / `pbot mcp`），对外暴露 **`pbot_worker`** 工具，并在 Pi/dsh 中提供对应的 **`/pbot worker`** 命令。

## 与宿主原生 Subagent 互补

- **同宿主子任务与团队协作**：完全交给当前宿主的原生能力（例如 Claude 原生 `Agent`/团队、Antigravity 原生 `invoke_subagent`/`/swarm`、dsh 原生 `subagent`）。Personal Bot 不拦截、不覆盖、也不复制宿主原生 subagent 工具。
- **跨 Harness 专业分工**：当需要调用**另一个 Harness** 发挥其特长（例如在 Antigravity 中委派 Claude/Codex 编码，或在 Pi/dsh 中委派 Antigravity 探索、Claude 审查）时，统一通过 MCP 工具 **`pbot_worker`** 经标准 ACP v1 协议启动并管理目标 Harness 的独立 worker。
- **路由分工偏好**：哪些任务优先交给哪个 Harness，由用户在工作区 `AGENTS.md` 或 `agents/coordinator.md` 中自然约定，由主会话协调者自主决策，不在代码中硬编码工作流引擎。

## 多宿主统一挂载方式

| 宿主 | 挂载方式 | 工具名 |
| --- | --- | --- |
| Pi | 扩展启用时通过 `pi.registerMcpServer("pbot", ...)` 自动挂载 | `mcp__pbot__pbot_worker`（及 `/pbot worker`） |
| dsh | 插件启用时通过 `@deepseek-ai/dsh-mcp-client` 自动挂载 | `mcp__pbot__pbot_worker`（及 `/pbot worker`） |
| Claude Code | 根 `.mcp.json` 自动挂载 `${CLAUDE_PLUGIN_ROOT}/lib/extension/mcp.js` | `pbot_worker` |
| Antigravity | 插件 `mcp_config.json` 自动挂载 `./lib/extension/mcp.js` | `pbot_worker` |
| Codex / Cursor / 其他 MCP 宿主 | 手动配置 stdio MCP 命令 `npx personal-bot@latest mcp`（或 `pbot mcp`） | `pbot_worker` |

## `pbot_worker` 工具契约

| action | 必填字段 | 常用可选字段 | 行为 |
| --- | --- | --- | --- |
| `backends` | 无 | `workspace` | 探测已注册及 `.pbot/config.json` 自定义的 ACP 可执行文件可用性 |
| `start` | `backend` | `workspace`, `name`, `message`, `files`, `provider`, `model`, `thinking`, `cwd`, `waitMs` | 启动目标 Harness 的独立 ACP worker；`waitMs > 0` 时同步等待首轮完成并返回报告 |
| `wait` | `workerId` | `workspace`, `requestId`, `timeoutMs` | 阻塞等待指定或最新请求周期结束并返回报告（默认超时 120000 ms） |
| `send` | `workerId`, `message` | `workspace`, `delivery` | 向存活 worker 追加指令；运行中请使用 `delivery: "followUp"` |
| `status` | `workerId` | `workspace` | 查询执行状态、模型选择与最近周期状态（不读报告正文） |
| `list` | 无 | `workspace` | 列出当前会话创建的 worker |
| `read` | `workerId` | `workspace`, `cycleId`, `offset`, `limit` | 按字符偏移分页读取周期最终报告（单页上限 16000 字符） |
| `stop` | `workerId` | `workspace` | 请求停止 worker，保留历史与周期报告 |
| `resume` | `workerId`, `message` | `workspace` | 校验并恢复已停止 worker，携新要求继续工作（不重放旧请求） |
| `rename` | `workerId`, `name` | `workspace` | 更新 worker 显示名称 |

示例：

```json
{ "action": "backends", "workspace": "/path/to/workspace" }
{ "action": "start", "backend": "claude", "name": "实现专家", "message": "完成模块 A 并运行测试", "waitMs": 120000 }
{ "action": "send", "workerId": "<workerId>", "message": "补充边界测试", "delivery": "followUp" }
{ "action": "wait", "workerId": "<workerId>", "timeoutMs": 120000 }
```

在 Pi 与 dsh 聊天框中，也可直接以 `/pbot worker {"action":"list"}` 等命令操作当前会话的 worker（与该会话自动挂载的 MCP 服务共享同一会话归属）。

## 内置预设与任意自定义 ACP Harness

内置预设开箱即用，也可通过 `.pbot/config.json` 的 `acp` 字段覆盖或新增任意 ACP v1 程序（详见[工作区配置](workspace-configuration.md#acp-harness-配置acp)）：

| 预设 `backend` | 默认入口 | 安装与认证 |
| --- | --- | --- |
| `pi` | `pi-acp` | `npm install -g pi-acp`（另需 Pi）；运行 `pi` 完成登录与默认模型配置 |
| `dsh` | `dsh --profile acp` | `npm install -g @deepseek-ai/dsh@latest`；按 dsh 原生方式配置 profile |
| `claude` | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp`；在 Claude Code 完成登录或 API 配置 |
| `antigravity` | `agy acp` | 安装 Google Antigravity CLI（`agy`）并完成登录 |
| `codex` | `codex-acp` | `npm install -g @zed-industries/codex-acp`；在 Codex 完成登录或 API 配置 |
| 自定义名 | `.pbot/config.json` `acp.<name>` | 任意符合 ACP v1 的 stdio 程序，无需修改 Personal Bot 代码 |

## 执行与安全边界

- **模型与配置独立**：ACP worker 使用目标 Harness 自己的认证、模型、工具与技能，不继承父宿主默认模型；省略 `model`/`thinking` 时沿用目标默认配置。
- **上下文注入**：对于标准 ACP v1 目标，若对端声明 `sessionCapabilities.systemPrompt` 则在建会话时 append 公共约定与 `general-purpose` 职责；否则在首轮消息前自动前置一次，后续轮次不重复。
- **无交互权限**：MCP 模式下遇到未自动批准的 `session/request_permission` 默认快速返回 `cancelled` 以避免阻塞；若希望由运行环境自动放行，可设置 `PBOT_ACP_NONINTERACTIVE_PERMISSION=allow` 或由目标 Harness 自身权限模式处理。
- **进程生命周期**：每个 worker 运行在独立进程组中；MCP 服务或宿主会话关闭时自动停止并回收所属 worker 进程组。
