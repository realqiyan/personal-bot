# 工具与执行能力

Personal Bot 复用各宿主的原生 CLI、MCP、认证与权限体系，不额外包装第三方工具或自建软件权限门槛。

## 责任划分

| 内容 | 所有者 |
| --- | --- |
| CLI 参数、校验、认证 | 原生命令与 profile |
| 工作区共享 MCP（stdio / HTTP + 环境变量） | 工作区 `.pbot/mcp.json`（全宿主经 `workspace_mcp_*` 桥接，Pi/dsh 同步原生挂载，ACP worker 自动透传） |
| 宿主原生 MCP（含交互式浏览器 OAuth 或全局服务） | 当前宿主的原生 MCP（可与 `.pbot/mcp.json` 同时使用） |
| 工作区共享技能 | 工作区 `.agents/skills/<name>/SKILL.md`（Pi/dsh/Antigravity/Codex 原生发现；Claude Code 与通用 ACP worker 自动注入元数据索引） |
| 数据口径、项目约定与使用经验 | 工作区 `providers/<id>/GUIDE.md` |
| 跨 Harness 专家委派 | 统一 stdio MCP 服务（`worker_*` 工具集） |
| 任务范围与必要人工确认 | 用户与协调者模型 |
| 硬性权限隔离 | 只读凭据、服务端控制或执行沙箱 |

## 外部 CLI 与 MCP

- **工作区共享 MCP（推荐，跨宿主通用）**：使用 `pbot mcp add|remove|list` 维护 `.pbot/mcp.json`，凭据用 `${ENV_VAR}` 引用。所有宿主均可通过 `workspace_mcp_discover` / `workspace_mcp_call` 直接调用（修改即生效），Pi/dsh 同步原生挂载，ACP worker 自动继承。
- **宿主原生 MCP（交互式 OAuth 或全局服务）**：
  - **Pi**：项目级外部 MCP 使用 `pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），`/mcp` 查看来源与状态。
  - **dsh**：使用原生 `@deepseek-ai/dsh-mcp-client` 与 profile 配置管理外部 MCP。
  - **Claude Code**：使用 `claude mcp add --scope project <server> ...`（写入 `.mcp.json`），会话内 `/mcp` 核对状态。
  - **Antigravity**：全局使用 `agy mcp add|remove|list`（管理 `~/.gemini/config/mcp_config.json`）。
- 外部系统接入与排障使用工作区按需技能 [provider-connections](../../resources/skills/provider-connections/SKILL.md)。

## Python 计算

各宿主与 ACP worker 均通过原生 Bash 调用项目声明的 Python 解释器、依赖与工作目录，不修改 Python 环境变量。按需读取：
- 通用计算方法：[resources/references/compute.md](../../resources/references/compute.md)
- 技术指标与回测：[resources/references/compute-finance.md](../../resources/references/compute-finance.md)

## 可选 Task Conductor

周期任务、重复流程、DAG 或宿主关闭后仍需持续执行的任务使用可选的 `task-conductor-plugin`（通过宿主原生 MCP 接入），安装与配置遵循[上游接入指南](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。Personal Bot 通过 [resources/references/task-conductor.md](../../resources/references/task-conductor.md) 提供按需操作参考。
