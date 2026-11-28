# 工具与执行能力

Personal Bot 复用各宿主的原生 CLI、MCP、认证与权限体系，不额外包装第三方工具或自建软件权限门槛。

## 责任划分

| 内容 | 所有者 |
| --- | --- |
| CLI 参数、校验、认证 | 原生命令与 profile |
| 工作区共享 MCP（stdio / HTTP + 环境变量） | 工作区 `.pbot/mcp.json`（Pi/dsh 直接原生挂载；其余宿主经 `workspace_mcp_*` 桥接，二选一不重复暴露；ACP worker 自动透传） |
| 宿主原生 MCP（全局工具、原生插件/通知、交互式 OAuth 或独占本地资源） | 当前宿主的原生 MCP（与 `.pbot/mcp.json` 单点归属、互不重复注册） |
| 工作区共享技能 | 工作区 `.agents/skills/<name>/SKILL.md`（Pi/dsh/Antigravity/Codex/Qoder CLI 原生发现；Claude Code 与通用 ACP worker 自动注入元数据索引） |
| 数据口径、项目约定与使用经验 | 工作区 `providers/<id>/GUIDE.md` |
| 跨 Harness 专家委派 | 统一 stdio MCP 服务（`worker_*` 工具集） |
| 任务范围与必要人工确认 | 用户与协调者模型 |
| 硬性权限隔离 | 只读凭据、服务端控制或执行沙箱 |

## 外部 CLI 与 MCP

- **工作区共享 MCP（跨宿主业务工具）**：使用 `pbot mcp add|remove|list` 维护 `.pbot/mcp.json`，凭据用 `${ENV_VAR}` 引用。Pi/dsh 启用 `features.mcp`（默认）时直接原生挂载（不再重复暴露 `workspace_mcp_*`）；其余宿主通过 `workspace_mcp_discover` / `workspace_mcp_call` 动态调用（修改即生效），ACP worker 自动继承。
- **宿主原生 MCP（交互式 OAuth 或全局服务）**：
  - **Pi**：项目级外部 MCP 使用 `pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），`/mcp` 查看来源与状态。
  - **dsh**：使用原生 `@deepseek-ai/dsh-mcp-client` 与 profile 配置管理外部 MCP。
  - **Claude Code**：使用 `claude mcp add --scope project <server> ...`（写入 `.mcp.json`），会话内 `/mcp` 核对状态。
  - **Antigravity**：全局使用 `agy mcp add|remove|list`（管理 `~/.gemini/config/mcp_config.json`）。
  - **其他宿主（如 Codex、Qoder CLI）**：使用对应宿主自带的原生 MCP 命令或配置入口管理。
- 外部系统接入与排障使用工作区按需技能 [provider-connections](../../resources/skills/provider-connections/SKILL.md)。

## 运行环境与可选扩展

- **项目计算与脚本执行**：各宿主与 ACP worker 直接通过原生 Bash 遵循项目声明的解释器、依赖与工作目录。领域特定的计算规范或方法保存在工作区 `knowledge/` 或 `.agents/skills/` 中按需加载。
- **可选第三方插件与调度工具**：Personal Bot 不内置第三方插件的引导与操作手册；如需周期调度、DAG 或其他外部能力，直接按上游文档在对应宿主中安装配置并使用其自身技能或工具说明。
