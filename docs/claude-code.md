# Claude Code 使用

Personal Bot 在 Claude Code 中提供工作区资料、专业技能、原生通用专家和共享 Python。会话、模型、工具、MCP、团队与恢复由 Claude 自己管理。

## 安装与启用

支持 Linux 和 macOS，需要 Node.js 22.19+、Python 3.11+ 与 venv/ensurepip。Claude Code 当前最低及开发检查基线为 2.1.325。按[官方指南](https://code.claude.com/docs/en/quickstart)完成原生登录或 API 配置，然后在 Claude 中安装：

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

在目标工作区启动 Claude，运行：

```text
/personal-bot:pbot init
/personal-bot:pbot status
```

这是 Claude 的原生技能入口，会由模型执行插件的 Node 命令。`init` 补建资料目录和根 `AGENTS.md`，将该根目录 `.pbot/config.json` 的 `enabled` 设为 true，并准备共享 Python。已有资料、配置字段和 `CLAUDE.md` 保留。未配置、停用或配置无效时，插件只提供初始化提示；技能与专家的静态目录仍可能可见。

需要直接执行确定性命令时，使用实际插件目录：

```sh
node /absolute/path/to/personal-bot/lib/claude.js init
node /absolute/path/to/personal-bot/lib/claude.js status
node /absolute/path/to/personal-bot/lib/claude.js python setup
```

从工作区根目录执行。Claude hook 中的根目录取 `CLAUDE_PROJECT_DIR`，固定为启动项目；在普通 shell 中未提供该变量时使用当前目录。`status` 只读配置和 Python 状态。`pbot setup` 仍是 Pi 安装器，Claude 的安装、更新、认证、模型和权限使用原生入口。

## 资料、技能与专家

每次用户提交任务时，标准 command hook 读取共用启用配置，并加入公共工作约定、协调者职责、根 `AGENTS.md`、工作区角色补充和 Python 状态。修改配置或资料后在下一次任务生效。Claude 原生加载 `CLAUDE.md`、用户规则和原生工具；用户在 `CLAUDE.md` 中另行导入 `AGENTS.md` 时，也会保留其原生来源。

专业方法使用 `/personal-bot:project-maintenance` 和 `/personal-bot:provider-connections`。插件提供这些技能的静态目录，正文由 Claude 按需加载；未启用工作区时执行方法会提示先初始化。自己的项目技能放在 Claude 原生 `.claude/skills/<name>/SKILL.md`，已有布局与配置保持原样。

普通委派使用 Claude 原生 Agent，选择 `personal-bot:general-purpose`。该专家由 Markdown 文件声明；启动时加载当前工作区资料及专家职责补充。原生团队、成员通信、模型和权限都沿用 Claude 配置。使用实验团队时，由用户设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 和 teammate 模式。恢复主会话后明确说明要继续的工作；原生 resume/rewind 对进程内 teammate 的限制以当前 Claude 为准。

Claude 接入不提供 pbot 管理面板、历史工具、历史采集、自动摘要或 ACP 委派。查询旧 Claude 会话使用原生 `/resume` 等入口。Pi/dsh 保留自己的 pbot 历史与 ACP 功能，也仍可将 Claude 作为 ACP 目标；该目标适配独立于这里的插件 hooks。

## Python

已启用工作区在会话启动和任务提交时检查共享 venv；需要时准备 `python/requirements.lock` 中的依赖。首次安装可能需要数分钟。环境状态随任务上下文提供，ready 时包含 `python.executable`，通过 Bash 使用这个完整解释器路径：

```sh
"/absolute/path/to/shared/.venv/bin/python" -I -c 'import numpy; print(numpy.__version__)'
```

准备失败时，hook 提示或当次 `init`、`python setup` 结果包含安装错误；`status` 只检查当前环境，不保留先前进程的安装日志。修复条件后运行 `/personal-bot:pbot python setup`。项目构建和测试使用项目声明的环境。

插件不修改 Claude 的 PATH、shell 启动文件或系统 Python。停用共用配置后，后续任务停止加入资料和准备环境；禁用或卸载插件按 Claude 原生操作完成。资料、历史、旧控制记录和共享 venv 保留。

## 依赖与开发检查

Claude 集成使用标准 JSON command hooks、Markdown skills/agents 和 Node 内置模块。它不加载 mod API、宿主类型快照、内部 MCP server、原生 transcript 或团队存储。

`npm run build` 生成 Node hook 入口及原生专家文件。开发加载使用：

```sh
claude --plugin-dir /absolute/path/to/personal-bot
```

实际安装包检查使用 `npm pack` 和 `node scripts/check-claude-consumer.mjs <tarball>`。它验证独立消费、原生插件校验、Node 命令与 hook 协议，不调用模型。真实任务中的上下文、技能选择、专家和团队行为还需在批准环境核对，要求见[接入设计](claude-code-design.md)。
