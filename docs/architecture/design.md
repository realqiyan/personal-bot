# 技术设计

本文说明 Personal Bot 的模块分层、宿主生命周期、文件存储、精简交互、安装器与构建分发边界。架构原则见[架构原则](principles.md)，插件宿主与 ACP 扩展机制见[插件宿主与 ACP 扩展设计](extensibility.md)。

## 模块与依赖

下表列出源码的直接跨层依赖。单个模块的依赖由 `dependency-cruiser` 从导入关系生成，包含仅类型导入。入口负责装配，UI 通过宿主回调或 dsh Remote 取得数据。

| 消费层 | 直接使用的内部层 |
| --- | --- |
| 顶层宿主与协议入口 | extension、tools、ui、integrations、services、common |
| extension | tools、ui、integrations、services、storage、model、common。ACP 子进程负责读写控制文件，MCP 与宿主命令经服务访问存储 |
| tools | services、integrations、model、common |
| ui | model、common |
| services、integrations | storage、model、common |
| storage | model、common |
| model、common | 仅各自层内的源码 |

| 目录 | 责任 |
| --- | --- |
| `src/pbot.ts` / `src/dsh.ts` | Pi 与 dsh Host 装配（工作区生命周期、历史工具、原生 MCP 挂载） |
| `src/plugin.ts` / `src/claude.ts` | 通用插件宿主 CLI/hook 入口（查 `PluginHostRegistry`）与 Claude 兼容入口 |
| `src/mcp.ts` | 独立 stdio MCP 服务入口，暴露 6 个 `worker_*` 工具，按工作区功能与宿主原生挂载情况提供共享 MCP 和历史查询 |
| `src/extension/` | 运行时编排。 `hosts/` 装配宿主，`mcp/` 提供 MCP 服务与桥接，`acp/` 启动 worker，`history/` 执行共享历史命令，`cli/` 提供统一 CLI 路由与各子命令实现，`setup/` 提供 Pi 初始化保护 |
| `src/integrations/` | 按外部集成域划分的适配器：`hosts/`（各宿主平级目录 `pi/`、`dsh/`、`claude/`、`antigravity/` 及 `plugin-registry.ts`）、`acp/`（协议、`harnesses/` 与独立摘要执行器 `history-summary.ts`）、`installation/`（安装桥接），以及跨宿主辅助（`agent-resources.ts`） |
| `src/services/` | 宿主无关业务规则（`agents/`、`workspace/`、`history/`、`installation/`） |
| `src/model/` | 纯数据类型与窄能力契约（`plugin-host.ts`、`acp.ts`、`agent.ts`、`history.ts`、`workspace-config.ts`），不含实现或宿主 SDK 类型 |
| `src/storage/` | 原子 JSON、ACP worker 控制记录与历史归档存储 |
| `src/tools/` | `pbot_history` 契约与对称宿主注册（`history/pi-tool.ts`、`history/dsh-tool.ts`） |
| `src/ui/` | 宿主专属 UI（`pi/confirmation.ts`、`dsh/` Web 工作区与历史面板）及安装器交互（`setup.ts`） |
| `src/common/` | JSON、校验、Ajv Schema、文件、路径与版本辅助 |
| `resources/` | 模型可见提示词、角色、技能、参考资料与模板 |

### 目录归属与命名规范（扩展必循）

为保持顶层目录维度一致并确保 `dependency-cruiser` 静态隔离生效，新增宿主、扩展或功能模块统一遵循以下规则：

1. **所有宿主统一收拢在 `hosts/` 下**：
   - **进程内重 SDK 宿主（如 `pi`、`dsh`）**：按 `<host>/` 子目录对称存放——`src/extension/hosts/<host>/`、`src/integrations/hosts/<host>/`、`src/ui/<host>/` 与 `src/tools/<domain>/<host>-tool.ts`，并在 `.dependency-cruiser.cjs` 中声明跨宿主 SDK 隔离规则。
   - **无 SDK Hook 插件宿主（如 `claude`、`antigravity` 及新接入 IDE/CLI）**：在 `src/integrations/hosts/<host>/adapter.ts` 实现 `PluginHostAdapter` 并在 `src/integrations/hosts/plugin-registry.ts` 注册，共用 `src/extension/hosts/plugin-runtime.ts`，零宿主 SDK 依赖。
2. **跨宿主协议与运行域**：
   - **ACP Harness**：实现 `AcpHarnessAdapter` 放入 `src/integrations/acp/harnesses/<name>.ts` 并在 `src/integrations/acp/registry.ts` 注册；运行时在 `src/extension/acp/`；辅助模块避免与适配器重名（如 `acp/claude-settings.ts`）。
   - **MCP 服务与桥接**：统一放在 `src/extension/mcp/`。
   - **统一 CLI 与安装器**：CLI 路由与命令处理器在 `src/extension/cli/`，宿主安装器与升级器在 `src/integrations/installation/`。
3. **宿主无关业务与共享模块**：业务规则放 `src/services/<domain>/`，纯数据契约放 `src/model/`，存储放 `src/storage/`，跨宿主 UI/展示辅助放 `src/ui/` 顶层。

所有单向依赖与宿主 SDK 隔离规则由 `.dependency-cruiser.cjs` 静态强制。`common/validation` 保持零第三方依赖，`common/schema`（Ajv）仅由 Pi/dsh 历史工具与管理查询显式引入。

## 宿主生命周期与交互

所有宿主读取同一工作区根目录 `.pbot/config.json`，缺失、停用或损坏时保持休眠，不向上级目录继承：

- **Pi**：`session_start` 读取配置，启用后注册 `pbot_history`、通过 `pi.registerMcpServer("pbot", ...)` 挂载 `lib/extension/mcp.js`（注入 `PBOT_WORKSPACE_ROOT`、`PBOT_MCP_AGENT_DIR` 与当前 `PBOT_MCP_SESSION_ID`），并在 `before_agent_start` 刷新工作区上下文。`/pbot` 保留 `init`、`status`、`history` 与 `worker`（共享同一会话归属），工作区外写入触发安全确认队列。关闭或重载时自动注销 MCP 服务并清理资源。
- **dsh**：按根 Agent 的原始 `cwd` 读取配置，启用后注册技能、上下文、工作区外写保护、`pbot_history` 与根会话原始问答采集，并通过 `@deepseek-ai/dsh-mcp-client` 挂载同一 `lib/extension/mcp.js`（暴露 `mcp__pbot__worker_*`）。Web 工作台仅保留**工作区**与**历史**两页，经原生 Typert Remote（`snapshot`、`history`）查询，不增设 HTTP 服务；聊天命令为 `/pbot`、`status`、`init`、`history`、`worker`。
- **轻插件宿主（Claude Code、Antigravity 及后续扩展）**：由 `plugin-runtime.ts` 通过 `PluginHostAdapter` 处理无状态 command hook（上下文注入、技能门控与 `raw` 历史采集）及 `init`/`status` CLI，跨 Harness 调度与只读跨宿主历史查询由宿主挂载 `lib/extension/mcp.js` 完成。不设自定义面板，也不拦截宿主原生 subagent。

## 文件存储

| 位置 | 内容与所有者 |
| --- | --- |
| `<workspace>/.pbot/config.json` | 全宿主共用的启用开关、可选模块开关（`features: { prompts, skills, mcp, history }`）与开放 ACP Harness 配置 |
| `<workspace>/.pbot/mcp.json` | 全宿主与 ACP worker 共享的工作区 MCP 服务清单（stdio / Streamable HTTP，支持 `${ENV_VAR}` 展开） |
| `<workspace>/.agents/skills/<name>/SKILL.md` | 全宿主共享的工作区自有技能（原生支持目录的宿主直接发现，其余宿主与 ACP worker 按需注入元数据索引） |
| `<workspace>/AGENTS.md`、`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/` | 用户工作区资料（`init` 只补缺、不覆盖） |
| `<workspace>/.pbot/history/raw/[<YYYY>/<MM>/]<id>.json` | 全宿主（Pi、dsh、Claude Code、Antigravity 等）原始问答与已知分支（默认按 UTC `YYYY/MM/` 分层，可配置 `history.layout: "flat"` 切回平铺；各自只写本宿主来源） |
| `<workspace>/.pbot/history/summaries/<dimension>/[<YYYY>/<MM>/]<id>.json` | 按维度派生的摘要产物（内置 `session` 与 `monthly` 月度汇总，由 `SummaryRunner` 按 `.write-summary-<dimension>` 锁并发生成，携带来源指纹支持去重与增量更新，可独立重建，损坏不影响原始问答查询） |
| `~/.pbot/subagents/<id>/`（或 `PBOT_MCP_AGENT_DIR` / `PLUGIN_DATA/subagents`） | MCP `worker_*` 的控制记录（`descriptor.json`、`launch.json`、`acp-session.json`、`acp-process.json`、`acp-model.json`、`inbox/`、`completions/`、`reports/`、`permissions/`、`elicitations/`） |

- `atomic-json` 先校验对象再写入临时文件并原子替换，拒绝符号链接、路径越界与特殊文件；短目录锁（`.control` / `.write-<host>`）串行化控制写操作。
- 兼容线规则：发布版本遵循 `package.json` 的 `MAJOR.MINOR.PATCH`，1.0 前按次版本、之后按主版本判断控制记录兼容性，不引入自动迁移或存储版本计数器。

## 统一 CLI（`pbot`）

`bin/pbot.mjs` 直接委派给独立打包的 `lib/extension/cli.js`（同时保留 `lib/extension/workspace-cli.js` 兼容入口供既有插件技能调用），由 `src/extension/cli/index.ts` 统一负责参数提取（`--workspace`、`--json`、`--help`）、本地探针（`--version`、`--at-least`）、工作区版本自动更新中间件与声明式命令分发：
- `pbot init|status` 与 `pbot history status|list|summary|migrate|search|read`：与 Pi/dsh 共用 `src/extension/history/command.ts`。根目录、精确版本和输出契约见[历史与 CLI 指南](../guides/history.md)。
- `pbot upgrade|update [--workspace <dir>] [--version <ver>] [--hosts <h1,h2>] [--dsh-profile <name>] [--json]`：统一升级全局 CLI 与当前工作区已绑定的各宿主插件。
- `pbot mcp [list|add|remove ...]`：无参数时运行独立打包的 `lib/extension/mcp.js` 供任意 MCP 客户端连接；带子命令时管理工作区 `.pbot/mcp.json`。
- `pbot plugin <host> hook|init|status`：经 `PluginHostRegistry` 运行轻插件宿主的无状态 hook 或工作区命令。
- `pbot install <host|all> [--workspace <dir>] [--dsh-profile <name>] [--json]`：经 `HostInstallerRegistry` 为指定宿主或本机已安装的各宿主统一安装插件。

## 构建与分发

构建顺序固定为 **`dist → build:cli → build:dsh → build:plugins`**（`build:cli` 清空 `lib/`）：
1. `build:cli`：打包独立 CLI（`lib/extension/cli.js` 与 `lib/extension/workspace-cli.js` 兼容入口）。
2. `build:dsh`：编译 dsh Host，打包内置 TypeBox 及许可证，构建 Web 客户端模块 `lib/client.js`。
3. `build:plugins`：编译共享插件运行时（`lib/plugin.js`、`lib/claude.js`），用 `esbuild` 打包零外部依赖的 `lib/extension/mcp.js` 与 `lib/extension/acp-worker.js`（内联 `@agentclientprotocol/sdk`），执行已注册的各插件宿主目标（同步 Claude 清单、组装自包含 `lib/antigravity-plugin/`）。

宿主 SDK 与 TypeBox 均声明为 optional peer dependency，绝不进入 runtime dependencies；stdio MCP 服务仅用 Node 内置模块实现，插件缓存目录无 `node_modules` 亦可独立运行。详细脚本见[维护脚本](../../scripts/README.md)。
