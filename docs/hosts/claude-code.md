# Claude Code 使用指南

Personal Bot 以标准原生插件接入 Claude Code，提供工作区资料、专业技能门控以及跨 Harness 调度 MCP 服务（`pbot_worker`）。主会话、模型、权限、原生 `Agent` 子代理、原生团队与历史恢复完全由 Claude Code 管理，Personal Bot 不拦截也不覆盖原生 subagent。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+ 与 Claude Code 2.1.325+：

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

在目标工作区启动 Claude 后执行原生管理技能：

```text
/personal-bot:pbot init
/personal-bot:pbot status
```

需要确定性执行时，可从工作区根目录直接运行插件 CLI（可设 `CLAUDE_PROJECT_DIR` 固定根目录）：

```sh
node /absolute/path/to/personal-bot/lib/claude.js init
node /absolute/path/to/personal-bot/lib/claude.js status
```

`init` 补建资料目录与缺失的根 `AGENTS.md`，将 `.pbot/config.json` 的 `enabled` 设为 `true`，保留已有 `CLAUDE.md` 与其他配置字段。

## 资料、技能与互补协作

- **上下文注入**：`UserPromptSubmit` hook 读取 `.pbot/config.json`，已启用时仅为主会话注入公共工作约定、协调者职责、根 `AGENTS.md`、工作区 `agents/coordinator.md` 与环境路径；携带 `agent_id` 的原生子代理直接放行，不注入、不干扰。
- **技能门控**：包内声明 `project-maintenance` 与 `provider-connections`；未启用工作区时 `PreToolUse(Skill)` 与 `UserPromptExpansion` 拦截工作方法调用，始终放行 `/personal-bot:pbot`。工作区自有技能放在 `.claude/skills/<name>/SKILL.md`。
- **同宿主 vs 跨 Harness 互补**：
  - 同宿主任务与团队协作直接使用 Claude 原生 `Agent` 及原生团队（用户自行管理 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）；
  - 跨 Harness 调度（调用 `antigravity`、`codex`、`pi`、`dsh` 或自定义 ACP 目标）通过 [.mcp.json](../../.mcp.json) 自动挂载的 `pbot` stdio MCP 服务（工具 `pbot_worker`）完成，详见[跨 Harness 专家调度](../guides/cross-harness-workers.md)。
- **历史**：Claude 使用原生会话历史；既有 `.pbot/history/` 中的 Claude 归档保持只读保留。

## 本地开发与校验

```sh
npm run build
claude --plugin-dir /absolute/path/to/personal-bot
claude plugin validate --json ./.claude-plugin/plugin.json
```

打包消费验证见[维护脚本](../../scripts/README.md)。
