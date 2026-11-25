# 工具与执行能力

Personal Bot 复用各宿主的原生 CLI、MCP、认证与权限体系，不额外包装第三方工具或自建软件权限门槛。

## 责任划分

| 内容 | 所有者 |
| --- | --- |
| CLI 参数、校验、认证 | 原生命令与 profile |
| MCP 连接、认证、发现与调用 | 当前宿主的原生 MCP |
| 数据口径、项目约定与使用经验 | 工作区 `providers/<id>/GUIDE.md` |
| 跨 Harness 专家委派 | 统一 stdio MCP 服务 `pbot_worker` |
| 任务范围与必要人工确认 | 用户与协调者模型 |
| 硬性权限隔离 | 只读凭据、服务端控制或执行沙箱 |

## 外部 CLI 与 MCP

- **Pi**：项目级外部 MCP 使用 `pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），`/mcp` 查看来源与状态。
- **dsh**：使用原生 `@deepseek-ai/dsh-mcp-client` 与 profile 配置管理外部 MCP。
- **Claude Code**：使用 `claude mcp add --scope project <server> ...`（写入 `.mcp.json`），会话内 `/mcp` 核对状态。
- **Antigravity**：项目级 MCP 优先写入 `.agents/mcp_config.json`，全局使用 `agy mcp add|remove|list`。
- 外部系统接入与排障使用工作区按需技能 [provider-connections](../../resources/skills/provider-connections/SKILL.md)。

## Python 计算

各宿主与 ACP worker 均通过原生 Bash 调用项目声明的 Python 解释器、依赖与工作目录，不修改 Python 环境变量。按需读取：
- 通用计算方法：[resources/references/compute.md](../../resources/references/compute.md)
- 技术指标与回测：[resources/references/compute-finance.md](../../resources/references/compute-finance.md)

## 可选 Task Conductor

周期任务、重复流程、DAG 或宿主关闭后仍需持续执行的任务使用可选的 `task-conductor-plugin`（通过宿主原生 MCP 接入），安装与配置遵循[上游接入指南](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。Personal Bot 通过 [resources/references/task-conductor.md](../../resources/references/task-conductor.md) 提供按需操作参考。
