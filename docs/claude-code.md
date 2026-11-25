# Claude Code 使用

Personal Bot 在 Claude Code 中提供工作区资料、专业技能、原生通用专家以及跨 Harness ACP 调度能力。主会话、模型、权限、原生工具与原生团队由 Claude 管理。设计边界见[轻插件宿主与跨 Harness 接入设计](plugin-hosts-design.md)。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+ 与 Claude Code 2.1.325+。完成原生登录或 API 配置后安装：

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

在目标工作区启动 Claude，通过原生技能初始化或查看状态：

```text
/personal-bot:pbot init
/personal-bot:pbot status
```

需要确定性执行时，从工作区根目录直接调用插件内 CLI（可设 `CLAUDE_PROJECT_DIR` 固定工作区根）：

```sh
node /absolute/path/to/personal-bot/lib/claude.js init
node /absolute/path/to/personal-bot/lib/claude.js status
```

`init` 补建资料目录和根 `AGENTS.md`，将 `.pbot/config.json` 的 `enabled` 设为 `true`，保留已有资料、配置字段和 `CLAUDE.md`。未启用或配置无效时，hook 不注入业务资料并拦截工作方法调用，保留 `/personal-bot:pbot` 可用。

## 资料、技能与专家

- **上下文**：`UserPromptSubmit` 读取 `.pbot/config.json`，已启用时注入公共工作约定、协调者职责、根 `AGENTS.md`、工作区 `agents/coordinator.md` 及 `workspaceRoot`/`resourceRoot`。Claude 原生加载 `CLAUDE.md` 与用户规则。
- **技能**：包内提供 `/personal-bot:project-maintenance` 与 `/personal-bot:provider-connections`；项目自有技能放在 `.claude/skills/<name>/SKILL.md`。
- **同宿主专家与团队**：使用 Claude 原生 Agent（`personal-bot:general-purpose`），`SubagentStart` 自动补充工作区 `agents/general-purpose.md` 与环境路径。原生团队由用户自行配置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 与 teammate 模式；恢复会话后显式继续工作。
- **跨 Harness 调度**：插件通过 [.mcp.json](../.mcp.json) 自动挂载 `personal-bot-agents` stdio MCP 服务，暴露 `pbot_agent` 工具，可从 Claude 委派 `antigravity`、`codex`、`pi`、`dsh` 或 `.pbot/config.json` 中自定义的 ACP Harness（`backends` / `start` / `wait` / `send` / `read` / `stop` / `resume`）。在工作区 `AGENTS.md` 或 `agents/coordinator.md` 中约定各任务分工偏好即可。
- **历史与面板**：Claude 不提供 pbot 管理面板或历史采集，旧会话使用原生 `/resume` 等入口；既有历史归档保持只读保留。

## 计算与开发检查

- 计算通过原生 Bash 使用项目声明的解释器与依赖，方法见 [Python 计算](../resources/references/compute.md)与[指标与回测](../resources/references/compute-finance.md)。
- 本地开发加载与安装包验证：

```sh
npm run build
claude --plugin-dir /absolute/path/to/personal-bot
claude plugin validate --json ./.claude-plugin/plugin.json
```

打包消费检查使用 `npm pack` 与 `node scripts/check-claude-consumer.mjs <tarball>`。
