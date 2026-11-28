# 架构原则

## 两根核心支柱

Personal Bot 不绑定单一宿主，所有能力按两条正交主线组织：

1. **工作区与上下文层**：所有宿主共享同一份 `.pbot/config.json`、资料布局、公共约定、协调者职责与专业技能。轻插件宿主通过窄协议接口 `PluginHostAdapter` 与动态注册表 `PluginHostRegistry` 接入，共享同一套插件运行时与上下文拼装逻辑。
2. **统一 MCP 跨 Harness 专家调度层**：所有宿主（Pi、dsh、Claude Code、Antigravity、Codex 及任意 MCP 客户端）统一通过同一份薄 stdio MCP 服务（`lib/extension/mcp.js` / `pbot mcp`）调用 6 个读写分离的 **`worker_*`** 工具（`worker_create`、`worker_close`、`worker_request`、`worker_response`、`worker_output`、`worker_discover`；Pi/dsh 另提供 `/pbot worker` 命令），基于共享 `AgentService` 与可扩展 `AcpHarnessRegistry` 经标准 ACP v1（含权限与 `elicitation` 交互）调度任意目标 Harness。

## 与宿主原生能力互补，不干扰原生 Subagent

- 同宿主子任务、团队、会话恢复、模型配置、权限与外部 MCP 均由各自宿主负责。
- **不拦截、不覆盖、不复制宿主原生 subagent 工具**：不注入覆盖性的静态 `general-purpose` agent，不拦截 `invoke_subagent` / `SubagentStart`，也不在 Pi/dsh 中重复维护自有原生子会话或团队调度引擎（Pi/dsh 仅保留 `pbot_history` 与极简工作区入口）。
- 跨 Harness 分工偏好（如编码、分析、探索分别使用哪个 Harness）由用户在工作区 `AGENTS.md` 或 `agents/coordinator.md` 中约定，协调者模型按需调用 `worker_*`，不在代码中硬编码工作流引擎。

## 可扩展、运行时不感知

- **插件宿主扩展**：新增轻插件宿主只需在 `src/integrations/hosts/<host>/adapter.ts` 实现 `PluginHostAdapter` 并注册到 `PluginHostRegistry`（及在 `scripts/build-plugins.mjs` 追加构建目标），`src/extension/hosts/plugin-runtime.ts`、`src/plugin.ts` 与 `agent-resources.ts` 不感知具体宿主标识。
- **ACP Harness 扩展**：任意标准 ACP v1 程序在 `.pbot/config.json` 的 `acp` 字段声明 `{ command, args, env? }` 即可零代码接入；需要特殊会话参数或模型解析的 Harness 在 `src/integrations/acp/harnesses/<name>.ts` 实现 `AcpHarnessAdapter` 并注册到 `AcpHarnessRegistry`，`src/extension/acp/worker.ts`、`connection.ts`、`launch.ts` 与 `model-selection.ts` 不包含任何特定 Harness 分支。

## 保持单向依赖与对称目录维度

- 宿主入口与 extension 装配服务和适配器。tools 调用服务，UI 经宿主接口取得业务数据。services 与 integrations 通过 model 共享能力契约，两层分别访问所需存储。直接依赖见[技术设计](design.md)，静态边界由 `.dependency-cruiser.cjs` 检查。
- `src/extension/` 按运行域划分为 `hosts/`、`mcp/`、`acp/`、`history/` 和 `setup/`。宿主与 CLI 在 `history/` 共用历史命令。 `src/integrations/` 按外部集成域划分为 `hosts/`、`acp/` 和 `installation/`。具体宿主在 `hosts/` 下平级建目录。详见[技术设计](design.md)。
- 资源的创建、状态变更和释放由同一责任主体管理。工具与服务绑定工作区实例，关闭后旧调用失效。

## 区分两类文档方法论

- **技术与使用文档（`AGENTS.md`、`README*.md`、`docs/`、`scripts/README.md`）**：只维护当前设计目标、设计方法、模块边界与操作方式；直接重写或删除过时内容，历史交由 Git 保存。
- **模型可见运行时资料（`resources/`）**：严格遵循[模型指令编写原则](model-instruction-guidelines.md)，只写直接影响操作的规则与入口，按需加载专业方法，绝不混入仓库架构、构建方式或开发规范。

## 验证行为

使用真实本地文件、进程与宿主 SDK 测试业务契约与失败风险，不使用 mock、假模型或个人凭据，不测试提示文案。
