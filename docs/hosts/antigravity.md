# Antigravity 使用指南

Personal Bot 以自包含原生插件（`lib/antigravity-plugin/`）接入 Google Antigravity（CLI `agy` 与 Antigravity App），提供共享工作区资料、专业技能门控以及跨 Harness 调度 MCP 服务（`pbot_worker`）。会话、模型、权限、原生 `AGENTS.md` 发现、原生 `invoke_subagent` 与 `/swarm` 完全由 Antigravity 管理，Personal Bot 不拦截也不覆盖原生 subagent。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+ 与 Antigravity CLI（`agy` 1.5+）：

```sh
npx personal-bot@latest install-antigravity
```

从源码本地构建安装：

```sh
npm run build
node bin/pbot.mjs install-antigravity
# 或直接调用原生命令
agy plugin install ./lib/antigravity-plugin
```

在目标工作区启动 Antigravity 后执行原生管理技能：

```text
/pbot init
/pbot status
```

需要确定性执行时，可在工作区根目录直接运行插件 CLI：

```sh
node /path/to/installed/personal-bot/lib/plugin.js antigravity init
node /path/to/installed/personal-bot/lib/plugin.js antigravity status
```

## 资料、技能与互补协作

- **上下文注入**：Antigravity 原生发现并去重工作区 `AGENTS.md` / `GEMINI.md`；已启用工作区在 `SessionStart` 一次性通过 `injectSteps` 注入公共工作约定、协调者职责、工作区 `agents/coordinator.md` 补充及 `workspaceRoot`/`resourceRoot`。
- **技能门控**：插件提供 `project-maintenance` 与 `provider-connections`；未启用工作区时 `PreToolUse(read_file)` 拦截插件工作方法技能读取并放行 `pbot`，其余工具调用统一返回 `{ decision: "allow" }`。工作区自有技能放在 `.agents/skills/<name>/SKILL.md`。
- **同宿主 vs 跨 Harness 互补**：
  - 同宿主子任务与多成员协作直接使用 Antigravity 原生 `invoke_subagent`（`self`、`research` 等）与 `/swarm`，Personal Bot 不注入自定义静态 agent 也不改写 `invoke_subagent` 参数；
  - 跨 Harness 调度（调用 `claude`、`codex`、`pi`、`dsh` 或自定义 ACP 目标）通过插件内置 `mcp_config.json` 挂载的 `pbot` stdio MCP 服务（工具 `pbot_worker`）完成，详见[跨 Harness 专家调度](../guides/cross-harness-workers.md)。

## MCP 与开发校验

- 项目级外部 MCP 优先写入 `.agents/mcp_config.json`，全局使用 `agy mcp add|remove|list`。
- 开发校验命令：

```sh
npm run build
agy plugin validate --strict ./lib/antigravity-plugin --json
```
