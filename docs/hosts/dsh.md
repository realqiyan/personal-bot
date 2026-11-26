# dsh 使用指南

Personal Bot 以原生插件形式接入 DeepSeek Harness（dsh），提供工作区资料与技能、Web 工作区/历史管理页、`pbot_history` 历史检索，并通过 `@deepseek-ai/dsh-mcp-client` 自动挂载统一的跨 Harness 调度 MCP 服务（`mcp__pbot__worker_*`）。dsh 原生会话、模型、认证、原生 `subagent` 工具与外部 MCP 保持完全独立，不被干扰或覆盖。

最低宿主版本为 `0.2.2-rc.1`，需要 Node.js 24.9+、npm 与 pnpm。

## 安装与首次启动

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# 仅首次创建 profile；会覆盖已有同名 profile
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

在浏览器中选择工作区和主会话，配置模型与认证后，在聊天框执行：

```text
/pbot status
/pbot init
/pbot
```

- `/pbot init` 补建资料目录与缺失的根 `AGENTS.md`，写入 `.pbot/config.json` 并立即启用该目录下已打开的主会话。
- 裸 `/pbot` 打开精简 Web 工作台（**工作区** 与 **历史** 两个页签）。
- 桌面应用可在“插件 → 添加插件”安装 `personal-bot@latest`（使用独立的 desktop profile）。

## 日常启动与更新

```bash
# 日常启动
dsh --profile pbot
# 指定端口且不自动打开浏览器
dsh --profile pbot --port 8080 --no-open

# 更新插件（先停止服务）
npm install -g @deepseek-ai/dsh@latest pnpm@latest
dsh plugin --profile pbot update personal-bot --latest
```

从源码打包安装：

```bash
npm ci --ignore-scripts
npm pack
dsh plugin --profile pbot add /absolute/path/to/personal-bot-<version>.tgz
```

## 聊天命令与工具

以下命令在 dsh 聊天输入框执行：

| 命令 | 用途 |
| --- | --- |
| `/pbot` | 打开 Web 工作台（服务端无参数调用返回 status） |
| `/pbot status` | 查看工作区、启用状态、模型与历史整理状态 |
| `/pbot init` | 初始化工作区资料并启用 |
| `/pbot worker [命令] [JSON]` | 直接调用跨 Harness worker 工具（如 `/pbot worker status`、`/pbot worker backends`、`/pbot worker models claude`、`/pbot worker create {"backend":"codex"}`） |
| `/pbot history {"action":"search"}` | 查询或读取工作区历史归档（`search` / `read`） |

已启用主会话中，模型工具包括：
- **dsh 原生 `subagent` / `subagent_fork`**：同宿主轻量委派，Personal Bot 不拦截也不覆盖。
- **MCP 工具 `mcp__pbot__worker_*` 与 `mcp__pbot__workspace_mcp_*`**：通过 `@deepseek-ai/dsh-mcp-client` 自动挂载 `lib/extension/mcp.js`，暴露跨 Harness 专家调度与工作区 `.pbot/mcp.json` 桥接工具；启用 `features.mcp`（默认）时同时将 `.pbot/mcp.json` 中的服务通过原生 `@deepseek-ai/dsh-mcp-client` 挂载到当前工作区会话（两者可与 dsh profile 原生 MCP 同时使用）。
- **原生工具 `pbot_history`**：跨来源搜索与读取历史问答及摘要，详见[历史对话](../guides/history.md)。

主会话通过原生 `write`/`edit`/`apply_patch` 修改工作区外文件时触发一次原生批准。Web 工作台只读查询通过原生 Typert Remote（`snapshot`、`history`）完成，不启动额外 HTTP 服务。
