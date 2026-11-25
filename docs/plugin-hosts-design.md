# 轻插件宿主与跨 Harness 接入设计

本文说明 Claude Code、Antigravity 及后续同类轻插件宿主的统一接入架构，以及不绑定宿主的跨 Harness 专家调度设计。系统总览见[技术设计](technical-design.md)。

## 设计目标

1. **宿主无关的工作区**：无论用户在哪个 Harness 打开同一工作区，共享同一份 `.pbot/config.json`、资料目录、`resources/` 提示词与专业技能。
2. **薄协议适配，零重复业务**：工作区根目录校验、配置检查、初始化、上下文拼装与技能准入只维护一份核心实现；新增宿主只需提供一个薄协议适配器。
3. **跨 Harness 双向互调**：任意主宿主都能通过统一 ACP 后端委派其他 Harness（例如用 Antigravity 探索、Claude/Codex 编码、Pi 分析），不绑定单一宿主。
4. **插件缓存零依赖运行**：Claude marketplace 与 Antigravity 插件目录安装后不含 `node_modules`，所有 hook、CLI 与 MCP/ACP 入口必须自包含运行。

## 统一插件宿主适配层

```text
src/plugin.ts / src/claude.ts
        ↓
src/extension/plugin-runtime.ts   (唯一业务逻辑：init/status/hook 调度)
   ├── src/services/workspace/*   (.pbot/config.json 与目录初始化)
   ├── src/integrations/agent-resources.ts  (统一上下文拼装)
   └── PluginHostAdapter (src/model/plugin-host.ts)
         ├── src/integrations/hosts/claude.ts
         └── src/integrations/hosts/antigravity.ts
```

`PluginHostAdapter` 只隔离协议差异，不承载业务规则：

| 职责 | Claude Code (`claudeAdapter`) | Antigravity (`antigravityAdapter`) |
| --- | --- | --- |
| 工作区根目录 | `CLAUDE_PROJECT_DIR`（回退 `cwd`） | `workspacePaths[0]`（回退 `cwd`） |
| 根 `AGENTS.md` | 宿主不自动加载，由上下文拼装附带（`nativeRootAgents: false`） | 宿主原生发现并去重，不重复注入（`nativeRootAgents: true`） |
| 协调者上下文注入 | `UserPromptSubmit` → `hookSpecificOutput.additionalContext` | `SessionStart` → `injectSteps[].systemMessage`（会话首轮一次性注入） |
| 专家工作区补充 | `SubagentStart`（`personal-bot:general-purpose`） | `PreToolUse` 匹配 `invoke_subagent(general-purpose)`，通过 `overwrite.Prompt` 前置补充 |
| 未启用技能拦截 | `PreToolUse(Skill)` 与 `UserPromptExpansion` 拦截工作方法，放行 `personal-bot:pbot` | `PreToolUse(read_file)` 拦截插件 `skills/` 下工作方法，放行 `pbot`；其余返回 `{ decision: "allow" }` |
| 管理入口 | `/personal-bot:pbot init|status` → `lib/claude.js` | `/pbot init|status` → `lib/plugin.js antigravity` |

关键约束：
- **Antigravity `PreToolUse` 必须返回 `decision`**：放行路径统一返回 `{ decision: "allow" }`（交还宿主默认权限策略），禁止返回空对象 `{}`。
- **Antigravity 不使用 `PreInvocation` 注入全文**：`PreInvocation` 每次模型推理步前均会触发且 `systemMessage` 持久写入轨迹，上下文注入固定放在 `SessionStart`。
- **防重复注入**：当环境存在 `PBOT_SUBAGENT_RUN_ID`（作为 ACP 子代理运行时），`plugin-runtime` 直接走适配器放行响应，避免叠加主会话上下文。

## 跨 Harness 调度（通用 ACP + 薄 stdio MCP）

### 1. 开放 ACP 下游

- [src/integrations/acp/launch.ts](../src/integrations/acp/launch.ts) 内置 5 个预设目标：`pi`（`pi-acp`）、`dsh`（`dsh --profile acp`）、`claude`（`claude-agent-acp`）、`antigravity`（`agy acp`）、`codex`（`codex-acp`）。
- `.pbot/config.json` 的 `acp` 字段接受任意合法标识符（`/^[a-z0-9][a-z0-9-]{0,63}$/`）及 `{ command, args }`，可覆盖内置命令或接入任意自定义 ACP Harness。
- [src/extension/acp-worker.ts](../src/extension/acp-worker.ts) 统一处理两类目标：
  - `pi` / `dsh`：使用受管成员入口提取精确最终答复快照；
  - `claude` / `antigravity` / `codex` / 自定义 ACP：加载 `general-purpose` 工作区上下文；若目标支持标准 `sessionCapabilities.systemPrompt` 则随会话创建传入，否则在首轮消息前自动前置（后续轮次不重复），并按流式 `agent_message_chunk` 收集最终报告。

### 2. 薄 stdio MCP 上游

- [src/extension/mcp-agents.ts](../src/extension/mcp-agents.ts) 与 [src/mcp.ts](../src/mcp.ts) 用 Node 内置模块实现标准 JSON-RPC 2.0 stdio MCP 服务（不引入 `@modelcontextprotocol/sdk`），直接复用共享 `AgentService` 与 `AgentBackends`。
- 暴露统一工具 `pbot_agent`：
  - `backends`：探测内置与自定义 ACP 可执行文件可用性；
  - `start`（支持可选 `waitMs` 同步等待）、`wait`（自动追踪当前代次最新请求直至周期完成并返回报告）、`send`、`status`、`list`、`read`、`stop`、`resume`、`rename`；
  - 支持显式传 `workspace`（回退 `CLAUDE_PROJECT_DIR` / `PBOT_WORKSPACE_ROOT` / `cwd`），按工作区校验 `.pbot/config.json` 启用状态。
- **简化边界**：MCP 模式不提供自定义审批 TUI、pbot 团队调度或历史归档。在 `host === "mcp"` 下，`acp-worker` 收到 `session/request_permission` 时默认快速返回 `cancelled` 避免阻塞（设置 `PBOT_ACP_NONINTERACTIVE_PERMISSION=allow` 时自动选择允许项）。
- **多宿主挂载**：
  - Claude 插件通过根 [.mcp.json](../.mcp.json) 挂载 `${CLAUDE_PLUGIN_ROOT}/lib/extension/mcp.js`；
  - Antigravity 插件通过 `lib/antigravity-plugin/mcp_config.json` 挂载 `./lib/extension/mcp.js`；
  - Codex / Cursor 等其他 MCP 宿主可直接运行 `pbot mcp`（或 `npx personal-bot@latest mcp`）。

## 构建与分发边界

[scripts/build-plugins.mjs](../scripts/build-plugins.mjs) 一次构建同时完成两套插件产出：
1. 编译共享插件运行时（`lib/plugin.js` 与兼容入口 `lib/claude.js`）；
2. 用 `esbuild` 将 `lib/extension/mcp.js` 与 `lib/extension/acp-worker.js` 打成独立 ESM 文件（内置 `@agentclientprotocol/sdk`）；
3. 由 [resources/agents/general-purpose.md](../resources/agents/general-purpose.md) 统一生成 Claude 与 Antigravity 的静态专家声明；
4. 组装完全自包含的 `lib/antigravity-plugin/`（含 `package.json`、`plugin.json`、`hooks.json`、`mcp_config.json`、`agents/`、`skills/`、`lib/`、`resources/`），避免与根 `.claude-plugin/` 和 `hooks/hooks.json` 冲突。

验证边界：
- 静态与协议校验：`npm run check`、`npm test`、`agy plugin validate --strict ./lib/antigravity-plugin --json`、`claude plugin validate --json ./.claude-plugin/plugin.json`；
- 真实模型环境下各宿主首轮上下文、技能选择与跨宿主实测调用在独立批准环境单独验收。
