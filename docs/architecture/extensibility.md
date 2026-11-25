# 插件宿主与 ACP 扩展设计

本文说明 Personal Bot 如何通过两套对称的窄接口与动态注册表，实现**插件宿主可扩展**与**ACP Harness 可扩展**，使核心运行时对具体宿主与具体 Harness 完全不感知。

## 1. 可扩展插件宿主（`PluginHostRegistry`）

```text
src/plugin.ts (动态查表，无硬编码宿主名)
        ↓
src/extension/plugin-runtime.ts (唯一核心逻辑：init/status/hook 引擎)
   ├── src/services/workspace/*
   ├── src/integrations/agent-resources.ts (按 adapter.coordinatorPrompt 组装)
   └── PluginHostRegistry (src/integrations/hosts/registry.ts)
         ├── claudeAdapter       (src/integrations/hosts/claude.ts)
         ├── antigravityAdapter  (src/integrations/hosts/antigravity.ts)
         └── <自定义宿主适配器>    (通过 registerPluginHost 动态注册)
```

### `PluginHostAdapter` 契约（`src/model/plugin-host.ts`）

- `host: string`：任意宿主标识符，运行时不做联合类型限制。
- `nativeRootAgents: boolean`：宿主是否原生加载工作区根 `AGENTS.md`（为 `false` 时由上下文拼装附带）。
- `coordinatorPrompt?: string`：主会话协调者操作导航文件（默认使用宿主无关的 `plugin-coordinator.md`）。
- `resolveRoot(cwd, rawPayload)`：从宿主环境变量或 hook 载荷解析绑定工作区根目录。
- `parseEvent(payload)`：将宿主原生 hook 载荷映射为窄事件（`ignore` | `inject-context` | `check-skill`）。**不提供 subagent 拦截事件**，确保不干扰宿主原生 subagent。
- `formatPass` / `formatContext` / `formatDeny`：输出宿主协议要求的 JSON 响应。

### 内置适配器对比

| 职责 | Claude Code (`claudeAdapter`) | Antigravity (`antigravityAdapter`) |
| --- | --- | --- |
| 工作区根目录 | `CLAUDE_PROJECT_DIR`（回退 `cwd`） | `workspacePaths[0]`（回退 `cwd`） |
| 根 `AGENTS.md` | 拼装附带（`nativeRootAgents: false`） | 宿主原生加载（`nativeRootAgents: true`） |
| 协调者上下文 | `UserPromptSubmit`（含 `agent_id` 的原生子代理直接忽略） | `SessionStart` → `injectSteps[].systemMessage` |
| 未启用技能门控 | `PreToolUse(Skill)` 与 `UserPromptExpansion` 拦截工作方法，放行 `pbot` | `PreToolUse(read_file)` 拦截插件工作方法技能，放行 `pbot`；其余返回 `{ decision: "allow" }` |
| 原生 subagent | 完全不拦截、不提供覆盖性静态 agent | 完全不拦截、不提供覆盖性静态 agent |

### 接入新插件宿主的步骤

1. 在 `src/integrations/hosts/<host>.ts` 实现 `PluginHostAdapter`。
2. 在 `src/integrations/hosts/registry.ts` 注册该适配器（或由外部入口调用 `registerPluginHost(adapter)`）。
3. 在 `scripts/build-plugins.mjs` 的 `pluginTargets` 中声明对应清单与构建输出（挂载共享 `lib/extension/mcp.js` 与 `lib/plugin.js <host> hook`）。
4. 核心运行时（`plugin-runtime.ts`、`src/plugin.ts`、`agent-resources.ts`）无需任何修改。

## 2. 可扩展 ACP Harness（`AcpHarnessRegistry`）

```text
MCP Server (src/extension/mcp-workers.ts) -> AgentService -> AcpWorkerHost -> acp-worker.ts
                                                                                 ↓
                                                          AcpHarnessRegistry (src/integrations/acp/registry.ts)
                                                            ├── genericAcpHarness (任意自定义 ACP v1 默认回退)
                                                            ├── standardAcpPresets (antigravity, codex, ...)
                                                            ├── piAcpHarness       (src/integrations/acp/harnesses/pi.ts)
                                                            ├── dshAcpHarness      (src/integrations/acp/harnesses/dsh.ts)
                                                            └── claudeAcpHarness   (src/integrations/acp/harnesses/claude.ts)
```

### `AcpHarnessAdapter` 契约（`src/model/acp.ts`）

- `id: string`、`defaultCommand?: { command, args, env? }`、`installHint?`、`configureHint?`：默认命令与诊断信息。
- `exactAnswer?` / `eagerSessionId?` / `requireSystemPrompt?`：声明受管成员快照提取、会话 ID 持久化时机与 `systemPrompt` 能力要求。
- `filterStartOptions?` / `validateStartOptions?`：按目标能力过滤或校验启动选项。
- `prepareLaunch?(context)`：返回实际启动 `{ command, env, sessionMeta?, defaultThinking? }`（例如 Pi 注入 `pbot-pi-acp.mjs`、dsh 生成 `--patch`、Claude 解析原生设置）。
- `parseModelValue?` / `formatModelQuery?`：隔离目标特有的模型标识格式（如 Pi 的 `provider/model`、dsh 的 JSON `[provider, model]`）。
- `customNotificationMethod?` / `parseCustomNotification?`：按需解析特定扩展通知（如 Claude `_claude/sdkMessage` 的 `resolvedModel`）。

### 两种零侵入扩展方式

1. **用户级零代码接入**：在工作区 `.pbot/config.json` 的 `acp` 字段声明任意 `{ "command", "args", "env?" }`。`resolveAcpHarness(id)` 自动回退到 `createGenericAcpHarness(id)`：支持标准 ACP v1 协议、自动按对端 `sessionCapabilities.systemPrompt` 决定 append 还是首轮前置工作区上下文，并按流式 `agent_message_chunk` 收集最终报告。
2. **开发者级特化适配**：新增 `src/integrations/acp/harnesses/<name>.ts` 实现 `AcpHarnessAdapter` 并调用 `registerAcpHarness` 注册。`acp-worker.ts`、`connection.ts`、`launch.ts`、`model-selection.ts` 与 `mcp-workers.ts` 均零修改。

## 3. 薄 stdio MCP 桥接（`pbot_worker`）

- `src/extension/mcp-workers.ts` 与 `src/mcp.ts` 使用 Node 内置模块实现 JSON-RPC 2.0 stdio MCP 服务（不依赖 `@modelcontextprotocol/sdk`），直接封装 `AgentService` + `AcpWorkerHost`。
- 每次调用动态读取工作区 `.pbot/config.json` 并刷新 `acp` 映射，新增自定义 Harness 即改即生效。
- 支持 `PBOT_MCP_SESSION_ID` 与 `PBOT_MCP_AGENT_DIR`，使 Pi/dsh 的 `/pbot worker` 命令与自动挂载的 MCP 进程共享同一会话归属。
- `lib/extension/mcp.js` 与 `lib/extension/acp-worker.js` 通过 `esbuild` 独立打包，确保插件缓存目录在无 `node_modules` 环境下稳定运行。
