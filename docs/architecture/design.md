# 技术设计

本文说明 Personal Bot 的模块分层、宿主生命周期、文件存储、精简交互、安装器与构建分发边界。架构原则见[架构原则](principles.md)，插件宿主与 ACP 扩展机制见[插件宿主与 ACP 扩展设计](extensibility.md)。

## 模块与依赖

```text
Pi / dsh 命令、历史工具与原生 MCP 挂载
Claude / Antigravity / 任意插件宿主 hooks、CLI 与薄 stdio MCP
         ↓
 tools / extension / ui
         ↓
      services
      ↙      ↘
 storage   窄能力约定 (model)
               ↑
          integrations (hosts / acp / pi / dsh / installation)
```

| 目录 | 责任 |
| --- | --- |
| `src/pbot.ts` / `src/dsh.ts` | Pi 与 dsh Host 装配（工作区生命周期、历史工具、原生 MCP 挂载） |
| `src/plugin.ts` / `src/claude.ts` | 通用插件宿主 CLI/hook 入口（查 `PluginHostRegistry`）与 Claude 兼容入口 |
| `src/mcp.ts` | 独立 stdio MCP 服务入口，暴露统一 `pbot_worker` |
| `src/extension/` | 宿主生命周期、`/pbot` 命令、`plugin-runtime.ts`、`mcp-workers.ts`、`acp-worker.ts`、`setup-cli.ts`、ACP 受管成员入口 |
| `src/integrations/` | 可扩展宿主适配器（`hosts/`）、可扩展 ACP Harness 适配器（`acp/`）、Pi/dsh 历史与资源适配、统一上下文拼装（`agent-resources.ts`）、安装器适配 |
| `src/services/` | 宿主无关业务规则（`agents/`、`workspace/`、`history/`、`installation/`） |
| `src/model/` | 纯数据类型与窄能力契约（`plugin-host.ts`、`acp.ts`、`agent.ts`、`history.ts`、`workspace-config.ts`），不含实现或宿主 SDK 类型 |
| `src/storage/` | 原子 JSON、ACP worker 控制记录与历史归档存储 |
| `src/tools/` | `pbot_history` 输入/输出契约与 Pi/dsh 工具注册 |
| `src/ui/` | Pi 安全确认队列、安装器交互与 dsh Web 工作区/历史面板 |
| `src/common/` | JSON、校验、Ajv Schema、文件、路径与版本辅助 |
| `resources/` | 模型可见提示词、角色、技能、参考资料与模板 |

所有单向依赖与宿主 SDK 隔离规则由 `.dependency-cruiser.cjs` 静态强制。`common/validation` 保持零第三方依赖，`common/schema`（Ajv）仅由 Pi/dsh 历史工具与管理查询显式引入。

## 宿主生命周期与交互

所有宿主读取同一工作区根目录 `.pbot/config.json`，缺失、停用或损坏时保持休眠，不向上级目录继承：

- **Pi**：`session_start` 读取配置，启用后注册 `pbot_history`、通过 `pi.registerMcpServer("pbot", ...)` 挂载 `lib/extension/mcp.js`（注入 `PBOT_WORKSPACE_ROOT`、`PBOT_MCP_AGENT_DIR` 与当前 `PBOT_MCP_SESSION_ID`），并在 `before_agent_start` 刷新工作区上下文。`/pbot` 仅保留 `init`、`status` 与 `worker`（共享同一会话归属），工作区外写入触发安全确认队列。关闭或重载时自动注销 MCP 服务并清理资源。
- **dsh**：按根 Agent 的原始 `cwd` 读取配置，启用后注册技能、上下文、工作区外写保护、`pbot_history` 与后台历史整理，并通过 `@deepseek-ai/dsh-mcp-client` 挂载同一 `lib/extension/mcp.js`（暴露 `mcp__pbot__pbot_worker`）。Web 工作台仅保留**工作区**与**历史**两页，经原生 Typert Remote（`snapshot`、`history`）查询，不增设 HTTP 服务；聊天命令为 `/pbot`、`status`、`init`、`worker`、`history`。
- **轻插件宿主（Claude Code、Antigravity 及后续扩展）**：由 `plugin-runtime.ts` 通过 `PluginHostAdapter` 处理无状态 command hook 与 `init`/`status` CLI，跨 Harness 调度由宿主挂载 `lib/extension/mcp.js` 完成。不采集历史、不设自定义面板，也不拦截宿主原生 subagent。

## 文件存储

| 位置 | 内容与所有者 |
| --- | --- |
| `<workspace>/.pbot/config.json` | 全宿主共用的启用开关与开放 ACP Harness 配置 |
| `<workspace>/AGENTS.md`、`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/` | 用户工作区资料（`init` 只补缺、不覆盖） |
| `<workspace>/.pbot/history/raw/<id>.json` | Pi/dsh 原始问答与已知分支（各自只写本来源，既有 Claude 归档只读） |
| `<workspace>/.pbot/history/summary/<id>.json` | 派生分层摘要（可失效重建，损坏不影响原始问答查询） |
| `~/.pbot/subagents/<id>/`（或 `PBOT_MCP_AGENT_DIR` / `PLUGIN_DATA/subagents`） | MCP `pbot_worker` 的控制记录（`descriptor.json`、`launch.json`、`acp-session.json`、`acp-process.json`、`acp-model.json`、`inbox/`、`completions/`、`reports/`） |

- `atomic-json` 先校验对象再写入临时文件并原子替换，拒绝符号链接、路径越界与特殊文件；短目录锁（`.control` / `.write-<host>`）串行化控制写操作。
- 兼容线规则：发布版本遵循 `package.json` 的 `MAJOR.MINOR.PATCH`，1.0 前按次版本、之后按主版本判断控制记录兼容性，不引入自动迁移或存储版本计数器。

## 安装器（`pbot setup`）与 CLI

`bin/pbot.mjs` 路由到预构建 `lib/extension/setup-cli.js`，提供三个子命令：
- `pbot setup [--workspace <dir>]`：交互式检查环境、安装/更新 Pi 与工作区扩展，保留自定义本地/Git/固定来源，完成后通过临时 `setup-guard` 启动 Pi 执行 `/pbot init`。
- `pbot install-antigravity`：调用原生 `agy plugin install ./lib/antigravity-plugin` 安装或更新 Antigravity 插件。
- `pbot mcp`：直接运行独立打包的 `lib/extension/mcp.js` 供任意 MCP 客户端连接。

## 构建与分发

构建顺序固定为 **`dist → build:cli → build:dsh → build:plugins`**（`build:cli` 清空 `lib/`）：
1. `build:cli`：编译独立 CLI、Pi 检查桥接与 `setup-guard`。
2. `build:dsh`：编译 dsh Host，打包内置 TypeBox 及许可证，构建 Web 客户端模块 `lib/client.js`。
3. `build:plugins`：编译共享插件运行时（`lib/plugin.js`、`lib/claude.js`），用 `esbuild` 打包零外部依赖的 `lib/extension/mcp.js` 与 `lib/extension/acp-worker.js`（内联 `@agentclientprotocol/sdk`），执行已注册的各插件宿主目标（同步 Claude 清单、组装自包含 `lib/antigravity-plugin/`）。

宿主 SDK 与 TypeBox 均声明为 optional peer dependency，绝不进入 runtime dependencies；stdio MCP 服务仅用 Node 内置模块实现，插件缓存目录无 `node_modules` 亦可独立运行。详细脚本见[维护脚本](../../scripts/README.md)。
