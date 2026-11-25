# 架构原则

## 两根核心支柱

Personal Bot 不绑定单一宿主，核心能力按两条正交主线组织：

1. **工作区与上下文层**：所有宿主共享同一套 `.pbot/config.json`、资料布局、公共约定、角色职责与专业技能。轻插件宿主（Claude Code、Antigravity 及后续同类宿主）通过窄接口 `PluginHostAdapter` 隔离协议差异，共享同一套运行时与上下文拼装逻辑。
2. **跨 Harness 专家调度层**：基于共享 `AgentService` 与标准 ACP v1，开放支持 `pi`、`dsh`、`claude`、`antigravity`、`codex` 及 `.pbot/config.json` 自定义 ACP 目标。Pi/dsh 通过原生工具调用；Claude、Antigravity 及其他 MCP 宿主通过同一份薄 stdio MCP 服务调用，实现任意 Harness 间按特长分工互调。

## 复用宿主与克制 UI

- 各宿主负责自己的主会话、模型配置、工具、权限、资源发现与会话恢复。
- 不为终端宿主维护复杂的定制 TUI 菜单、阅读器或搜索界面；Pi 仅保留极简命令（`/pbot init`、`status`、`enter` 进 tmux 会话）与安全确认队列，日常专家/团队/历史操作交给模型工具。dsh 保留独立 Web 工作台，与轻插件主线互不耦合。
- 路由分工偏好（编码/分析/探索分别用哪个 Harness）记录在工作区资料中，由协调者模型按需决策，不在代码里硬编码工作流引擎。

## 保持单向依赖

- 保留顶层分层：`tools / extension / ui → services → storage / model`，`integrations` 只做协议适配不调用业务服务，`services` 不依赖宿主 SDK 或接入层。所有边界由 `.dependency-cruiser.cjs` 静态检查。
- 资源的创建、状态变更和释放由同一责任主体管理。工具绑定工作区实例，关闭后旧调用失效。

## 区分两类文档方法论

- **技术与使用文档（`AGENTS.md`、`README*.md`、`docs/`、`scripts/README.md`）**：只维护当前设计目标、设计方法、模块边界与操作方式；直接重写或删除过时内容与废弃限制，不保留补丁流水或验证日记，历史交由 Git 保存。
- **模型可见运行时资料（`resources/`）**：严格遵循[模型指令编写原则](model-instruction-guidelines.md)，只写直接影响操作的规则与入口，按需加载专业方法，绝不混入仓库架构、构建方式或开发规范。

## 验证行为

使用真实本地文件、进程与宿主 SDK 测试业务契约与失败风险，不使用 mock、假模型或个人凭据，不测试提示文案。
