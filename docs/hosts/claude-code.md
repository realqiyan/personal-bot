# Claude Code 使用指南

Personal Bot 以标准原生插件接入 Claude Code，提供工作区资料、专业技能门控以及跨 Harness 调度 MCP 服务（`worker_*`）。主会话、模型、权限、原生 `Agent` 子代理、原生团队与历史恢复完全由 Claude Code 管理，Personal Bot 不拦截也不覆盖原生 subagent。

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

- **上下文注入**：`UserPromptSubmit` hook 读取 `.pbot/config.json`，按 `features` 开关仅为主会话注入公共工作约定、协调者职责、根 `AGENTS.md`、工作区 `agents/coordinator.md`、工作区 `.agents/skills/` 技能元数据索引与环境路径；携带 `agent_id` 的原生子代理直接放行，不注入、不干扰。
- **技能门控与共享技能**：包内声明 `project-maintenance` 与 `provider-connections`；未启用工作区或 `features.skills: false` 时 `PreToolUse(Skill)` 与 `UserPromptExpansion` 拦截工作方法调用，始终放行 `/personal-bot:pbot`。工作区自有技能统一维护在 `.agents/skills/<name>/SKILL.md`（由上下文元数据索引按需加载，跨所有宿主通用）。
- **工作区统一 MCP**：`.pbot/mcp.json` 注册的跨宿主 MCP 经 [.mcp.json](../../.mcp.json) 挂载的 `pbot` MCP（`workspace_mcp_discover` / `workspace_mcp_call`）直接调用，可与 Claude 原生 `.mcp.json` 同时使用。
- **同宿主 vs 跨 Harness 互补**：
  - 同宿主任务与团队协作直接使用 Claude 原生 `Agent` 及原生团队（用户自行管理 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）；
  - 跨 Harness 调度（调用 `antigravity`、`codex`、`pi`、`dsh` 或自定义 ACP 目标）通过 [.mcp.json](../../.mcp.json) 自动挂载的 `pbot` stdio MCP 服务（`worker_*` 工具集）完成，详见[跨 Harness 专家调度](../guides/cross-harness-workers.md)。
- **历史归档**使用 `UserPromptSubmit` 与 `Stop` hook 将主会话问答写入 `.pbot/history/raw/`，跳过带 `agent_id` 的原生子代理。运行 `pbot history summary` 生成摘要，用 MCP 工具 `history_search` 和 `history_read` 检索各宿主的归档。`features.history: false` 可关闭历史功能。详见[历史与 CLI 指南](../guides/history.md)。

## 本地开发与校验

```sh
npm run build
claude --plugin-dir /absolute/path/to/personal-bot
claude plugin validate --json ./.claude-plugin/plugin.json
```

打包消费验证见[维护脚本](../../scripts/README.md)。
