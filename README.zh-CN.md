# Personal Bot

[English](README.md) | 简体中文

**连接知识、研究与行动的跨 Harness 个人助手层。**

Personal Bot 为多宿主环境（[Pi](https://pi.dev)、dsh、Claude Code、Antigravity 及可扩展的其他插件宿主）提供共享工作区资料与专业方法，并通过统一的 stdio MCP 工具集（`worker_create`、`worker_close`、`worker_request`、`worker_response`、`worker_output`、`worker_discover`）实现跨 Harness ACP v1 专家调度。同宿主子任务与团队完全交由宿主原生能力，两者互补互不干扰；Pi 与 dsh 另提供 `pbot_history` 历史检索。

快速导航：[文档总索引](docs/README.md) · [Pi](docs/hosts/pi.md) · [dsh](docs/hosts/dsh.md) · [Claude Code](docs/hosts/claude-code.md) · [Antigravity](docs/hosts/antigravity.md) · [跨 Harness 调度](docs/guides/cross-harness-workers.md)。

## 工作区启用

安装后在目标工作区运行初始化命令（Pi / dsh / Antigravity：`/pbot init`；Claude Code：`/personal-bot:pbot init`），补建缺失资料目录与根 `AGENTS.md`，并启用各宿主共用的 `.pbot/config.json`：

```json
{ "enabled": true }
```

配置缺失、停用或损坏时 Personal Bot 保持未启用，不干扰宿主原生能力；只检查绑定工作区根目录，不向父目录继承。详见[工作区配置](docs/guides/workspace-configuration.md)。

## 安装

### Pi

需要 Linux/macOS、Node.js 22.19+ 与 npm：

```bash
# 向导安装
npx personal-bot@latest setup

# 或在已有 Pi 的工作区安装
pi install --local npm:personal-bot
pi
```

在会话中执行 `/pbot init`。已启用后自动挂载 `pbot` MCP 服务（`worker_*`）与 `pbot_history`，提供 `/pbot init | status | worker`。详见 [Pi 使用指南](docs/hosts/pi.md)。

### dsh

需要 Node.js 24.9+、npm、pnpm 与 dsh `0.2.2-rc.1+`：

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

选择工作区并执行 `/pbot init`。已启用后通过原生 `@deepseek-ai/dsh-mcp-client` 自动挂载 `mcp__pbot__worker_*`，并提供 Web 工作区/历史面板与 `/pbot status | init | worker | history`。详见 [dsh 使用指南](docs/hosts/dsh.md)。

### Claude Code

需要 Linux/macOS、Node.js 22.19+ 与 Claude Code `2.1.325+`：

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

在工作区执行 `/personal-bot:pbot init`。插件通过标准 command hooks 注入主会话上下文并门控未启用技能，不拦截原生 `Agent`；跨 Harness 调度由内置 `.mcp.json` 挂载的 `worker_*` 提供。详见 [Claude Code 使用指南](docs/hosts/claude-code.md)。

### Antigravity

需要 Linux/macOS、Node.js 22.19+ 与 Antigravity CLI（`agy` `1.5+`）：

```bash
npx personal-bot@latest install-antigravity
```

在工作区执行 `/pbot init`。插件通过 `SessionStart`/`PreToolUse` hooks 注入上下文并门控未启用技能，不拦截原生 `invoke_subagent`/`/swarm`；跨 Harness 调度由内置 `mcp_config.json` 挂载的 `worker_*` 提供。详见 [Antigravity 使用指南](docs/hosts/antigravity.md)。

### 其他 MCP 宿主与自定义 ACP Harness

在 Codex、Cursor 等任意 MCP 宿主中使用 `worker_*`，将 stdio MCP 服务指向：

```bash
npx personal-bot@latest mcp
# 或全局安装后使用
pbot mcp
```

支持内置预设（`pi`、`dsh`、`claude`、`antigravity`、`codex`）及 `.pbot/config.json` 中声明的任意自定义 ACP v1 程序（支持 `{ "command", "args", "env?" }`），详见[跨 Harness 专家调度](docs/guides/cross-harness-workers.md)。

## 工作区资料

| 位置 | 用途 |
| --- | --- |
| `.pbot/config.json` | 全宿主共用的工作区启用与开放 ACP Harness 配置 |
| `AGENTS.md` | 项目导航、工作约定与可选的跨 Harness 分工偏好 |
| `areas/`、`projects/`、`knowledge/` | 长期事务、项目产物与可复用知识方法 |
| `providers/` | 外部 CLI/MCP 使用手册与数据口径 |
| `scratch/` | 临时脚本、计算数据与实验环境 |
| `agents/` | 角色职责补充（`coordinator.md`、`general-purpose.md`） |
| `.pbot/history/` | Pi/dsh 原始问答（`raw/`）与分层摘要（`summary/`）；既有 Claude 归档只读保留 |

## 开发与验证

当前版本 **0.3.0**。完整开发使用 Linux/macOS、Node.js 24.9+：

```bash
npm ci --ignore-scripts
npm run check
npm test
agy plugin validate --strict ./lib/antigravity-plugin --json
claude plugin validate --json ./.claude-plugin/plugin.json
git diff --check
```

- [文档总索引](docs/README.md)
- [架构原则](docs/architecture/principles.md) · [技术设计](docs/architecture/design.md) · [插件与 ACP 扩展设计](docs/architecture/extensibility.md)
- [npm 发布与验收](docs/maintainers/release.md) · [维护脚本](scripts/README.md) · [领域术语](CONTEXT.md)
