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

MCP 服务在 `initialize` 返回服务级说明 `instructions`，`tools/list` 根据已注册预设与当前工作区 `.pbot/config.json` 的 `acp` 配置动态探测本机可用 `backend` 并生成工具说明。

| action | 必填字段 | 常用可选字段 | 行为 |
| --- | --- | --- | --- |
| `start` | `message`（未设默认宿主时含 `backend`） | `backend`, `model`, `thinking`, `cwd`, `waitMs`, `workspace` | 启动独立 ACP worker，等待初始化与模型配置完成（参数非法立即报错），默认同步等待 50s 返回首轮报告（`waitMs: 0` 立即返回异步执行）；遇到待确认权限立即返回 `needsPermission: true` |
| `send` | `workerId`, `message` | `waitMs`, `workspace` | 向已有 worker 发送后续指令（若 worker 已停止则自动恢复会话），默认同步等待 50s 返回结果（`waitMs: 0` 异步） |
| `wait` | `workerId` | `waitMs`, `workspace` | 续等运行中 worker 结束（返回报告）或触发权限确认（返回 `needsPermission: true`），默认等待 50s |
| `permission` | `workerId`, `decision` | `permissionId`, `waitMs`, `workspace` | 回复 worker 转发的待处理权限请求（`decision` 为 `allow` / `deny` 或 `pendingPermissions[].options[].optionId`），默认继续等待 50s |
| `read` | `workerId` | `offset`, `workspace` | 按字符偏移读取或翻页续读最新周期报告（单页 16000 字符；被截断时返回 `nextOffset`） |
| `status` | 无 | `workerId`, `workspace` | 传 `workerId` 查询单个 worker 状态、生效模型、待处理权限与最近周期；省略 `workerId` 列出当前会话所有 worker |
| `stop` | `workerId` | `workspace` | 请求停止 worker，保留历史与周期报告 |
| `backends` | 无 | `workspace` | 探测已注册及 `.pbot/config.json` 自定义的 ACP 可执行文件可用性、别名与权限策略 |
| `models` | 无（未设默认宿主时含 `backend`） | `backend`, `model`, `workspace` | 临时建立 ACP 会话探测目标可选的模型与思考力度列表（不发 prompt）；省略 `backend` 时回退当前宿主（`PBOT_HOST`） |

示例：

```json
{ "action": "start", "backend": "codex", "message": "完成模块 A 并运行测试" }
{ "action": "start", "backend": "claude", "model": "opus", "thinking": "high", "message": "审查核心变更" }
{ "action": "send", "workerId": "<workerId>", "message": "补充边界测试" }
{ "action": "wait", "workerId": "<workerId>" }
{ "action": "permission", "workerId": "<workerId>", "decision": "allow" }
{ "action": "models", "backend": "claude" }
{ "action": "backends" }
```

在 Pi 与 dsh 聊天框中，也可直接以 `/pbot worker status`、`/pbot worker models claude` 或 `/pbot worker {"action":"backends"}` 等命令操作当前会话的 worker（与该会话自动挂载的 MCP 服务共享同一会话归属）。

## 内置预设与任意自定义 ACP Harness

内置预设开箱即用，支持忽略大小写与常见别名（如 `Claude Code`→`claude`、`OpenAI Codex`→`codex`、`agy`→`antigravity`；工作区自定义同名项优先于内置别名），也可通过 `.pbot/config.json` 的 `acp` 字段覆盖命令或调整权限策略（详见[工作区配置](workspace-configuration.md#acp-harness-配置acp)）：

| 预设 `backend` | 常用名称 / 别名 | 默认入口 | 安装与认证 |
| --- | --- | --- | --- |
| `pi` | Pi | `pi-acp` | `npm install -g pi-acp`（另需 Pi）；运行 `pi` 完成登录与默认模型配置 |
| `dsh` | DeepSeek dsh | `dsh --profile acp` | `npm install -g @deepseek-ai/dsh@latest`；按 dsh 原生方式配置 profile |
| `claude` | Claude Code (`claude-code`) | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp`；在 Claude Code 完成登录或 API 配置 |
| `antigravity` | Google Antigravity (`agy`) | `agy acp` | 安装 Google Antigravity CLI（`agy`）并完成登录 |
| `codex` | OpenAI Codex (`openai-codex`, `codex-cli`) | `codex-acp` | `npm install -g @zed-industries/codex-acp`；在 Codex 完成登录或 API 配置 |
| 自定义名 | `.pbot/config.json` `acp.<name>` | 自定义命令 | 任意符合 ACP v1 的 stdio 程序，无需修改 Personal Bot 代码 |

## 执行与安全边界

- **模型与配置独立**：ACP worker 使用目标 Harness 自己的认证、模型、工具与技能，不继承父宿主默认模型；省略 `model`/`thinking` 时沿用目标默认配置；显式指定时支持精确值、忽略大小写的显示名、唯一简名或多提供方格式 `provider/model`，非法值在 `start` 阶段即时报错并列出可用值。
- **上下文注入**：对于标准 ACP v1 目标，若对端声明 `sessionCapabilities.systemPrompt` 则在建会话时 append 公共约定与 `general-purpose` 职责；否则在首轮消息前自动前置一次，后续轮次不重复。
- **权限策略与主会话授权**：未配置 `acp.<name>.permission` 时默认沿用目标 Harness 原生权限策略，并在目标发起 `session/request_permission` 时以 `ask` 转发给主会话（`start`/`wait` 立即返回 `needsPermission: true` 与 `pendingPermissions`，由主会话确认后通过 `permission` action 回复）。可在 `.pbot/config.json` 按目标配置 `"permission": "ask" | "allow" | "deny"`。
- **进程生命周期**：每个 worker 运行在独立进程组中；MCP 服务或宿主会话关闭时自动停止并回收所属 worker 进程组。
