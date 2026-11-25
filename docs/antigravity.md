# Antigravity 使用

Personal Bot 以原生插件形式接入 Google Antigravity（CLI `agy` 与 Antigravity App），提供共享工作区资料、专业技能、原生通用专家以及跨 Harness ACP 调度能力。会话、模型、权限、原生 `AGENTS.md` 发现与 `/swarm` 由 Antigravity 管理。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+ 与 Antigravity CLI（`agy` 1.5+）。通过 npm 一键安装或更新插件：

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

在目标工作区启动 Antigravity 后，执行原生技能初始化并启用工作区：

```text
/pbot init
/pbot status
```

需要确定性执行时，可在工作区根目录直接运行插件内入口：

```sh
node /path/to/installed/personal-bot/lib/plugin.js antigravity init
node /path/to/installed/personal-bot/lib/plugin.js antigravity status
```

`init` 补建工作区资料目录与缺失的根 `AGENTS.md`，并将 `.pbot/config.json` 的 `enabled` 设为 `true`。未启用时，`SessionStart` 不注入业务上下文，插件内工作方法技能会被拦截并提示初始化，`/pbot` 管理技能保持可用。

## 资料、技能与专家

- **上下文与导航**：Antigravity 原生发现并加载工作区 `AGENTS.md` / `GEMINI.md`；已启用工作区在 `SessionStart` 一次性注入公共工作约定、协调者职责、工作区 `agents/coordinator.md` 补充及 `workspaceRoot`/`resourceRoot`。
- **专业技能**：插件提供 `project-maintenance` 与 `provider-connections` 技能；工作区自有技能放在 `.agents/skills/<name>/SKILL.md`。
- **同宿主专家与协作**：单任务委派使用原生 `invoke_subagent`（`general-purpose` 或内置只读 `research`），调用 `general-purpose` 时 hook 自动附带工作区 `agents/general-purpose.md` 补充与环境路径；多成员并行协作使用原生 `/swarm`。
- **跨 Harness 调度**：插件内置 `personal-bot-agents` stdio MCP 服务，暴露 `pbot_agent` 工具，可在 Antigravity 内调用 `claude`、`codex`、`pi`、`dsh` 或 `.pbot/config.json` 中自定义的 ACP Harness（支持 `backends`、`start`、`wait`、`send`、`read`、`stop`、`resume`）。在工作区 `AGENTS.md` 或 `agents/coordinator.md` 中写明编码、分析、探索等分工偏好即可。

## MCP 与开发检查

- 项目级 MCP 配置优先写入工作区 `.agents/mcp_config.json`，全局配置使用 `agy mcp add|remove|list`。
- 开发校验命令：

```sh
npm run build
agy plugin validate --strict ./lib/antigravity-plugin --json
```
