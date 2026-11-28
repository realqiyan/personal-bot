# Pi 使用指南

Personal Bot 以 Pi 扩展形式接入 [Pi](https://pi.dev)，提供共享工作区资料、专业技能、工作区外写保护、`pbot_history` 历史检索，并通过 Pi 原生 `registerMcpServer` 自动挂载统一的跨 Harness 调度 MCP 服务（`worker_*`）。会话、模型、认证与外部 MCP 均由 Pi 管理。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+ 与 npm。在目标工作区根目录执行：

```bash
# 通过 pbot CLI 安装
pbot install pi
# 或使用 Pi 原生命令
pi install --local npm:personal-bot
pi
```

在 Pi 聊天框执行 `/pbot init` 补建缺失资料目录与根 `AGENTS.md`，并写入 `.pbot/config.json`（`{ "enabled": true }`）。首次从停用状态初始化后自动触发 `/reload` 使工具、技能和 MCP 服务一起生效。

## 命令与工具

| 入口 | 用途 |
| --- | --- |
| `/pbot init` | 初始化工作区资料目录与根 `AGENTS.md` 并启用 Personal Bot |
| `/pbot status` | 查看工作区路径、启用状态、版本与历史整理状态 |
| `/pbot worker [命令] [JSON]` | 直接调用跨 Harness worker 工具（支持简写 `/pbot worker overview`、`/pbot worker status`、`/pbot worker backends`、`/pbot worker models [backend]`、`/pbot worker close <id>`，或工具名加 JSON 如 `/pbot worker create {"backend":"codex"}`） |
| `/reload` | Pi 原生命令，重载扩展、资源与 `.pbot/config.json` |

已启用工作区向模型暴露：
- **MCP 工具 `worker_*`**（`worker_create` / `worker_close` / `worker_request` / `worker_response` / `worker_output` / `worker_discover`，通过 `pbot` MCP 服务自动注册，直连共享 `lib/extension/mcp.js`）：用于调度其他 ACP Harness，详见[跨 Harness 专家调度](../guides/cross-harness-workers.md)。
- **原生工具 `pbot_history`**：搜索与读取本工作区历史归档，详见[历史对话](../guides/history.md)。

未启用或配置损坏时，Personal Bot 保持休眠，不注入提示词、不注册技能与工具，也不挂载 MCP 服务；状态栏提示 `/pbot init` 或配置错误。

## 原生 MCP、统一 MCP 与技能

- 工作区共享 MCP 统一写入 `.pbot/mcp.json`（`pbot mcp add|remove|list`），Pi 启用 `features.mcp`（默认）时自动通过 `pi.registerMcpServer` 直接原生挂载（不再重复暴露 `workspace_mcp_*` 桥接工具）；全局工具、需交互式 OAuth 或宿主私有的 MCP 仍可用 `pi mcp add [--local] <server> ...`（写入 `~/.pi/agent/mcp.json` 或 `.pi/mcp.json`）并与之单点归属、互不重复注册，用 `/mcp` 查看状态。
- 工作区自有技能统一放在 `.agents/skills/<name>/SKILL.md`；包内技能遵守 Pi 原生 `--no-skills`、包级过滤及 `.pbot/config.json` 的 `features.skills`。
- 修改工作区外文件时，Pi 通过安全确认队列提示人工确认。
