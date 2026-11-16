# Claude Code 标准插件接入

Claude 接入聚焦工作区资料、专业技能、原生通用专家与共享 Python。使用公开的 command hooks、Markdown skills 和 Markdown agents；主会话、原生工具、MCP、团队和恢复由 Claude 管理。使用操作见[Claude 指南](claude-code.md)，共用模块见[技术设计](technical-design.md)。

## 范围与依赖

Claude 插件不实现 pbot 面板、历史采集与检索、摘要、ACP 委派或 pbot 团队调度。Pi/dsh 的历史和 ACP 保留，其中 Claude 作为 ACP 目标的 SDK 适配继续由 ACP 模块负责。现有归档、控制记录和备份保留；持久合同不因功能收敛而迁移。

插件不依赖 function-hooks/mod、`claude-code` 类型声明、Node MCP server、内部 transcript、私有团队配置、父进程启动参数或原生消息收据。Claude hooks 使用 Node 内置模块和共用工作区/Python 服务。Claude SDK 仍是 Pi/dsh 的 Claude ACP 目标所需可选 peer 与精确开发依赖，Claude 插件本身不加载它。

## 入口与行为

| 入口 | 责任 |
| --- | --- |
| `.claude-plugin/plugin.json` | 声明共用技能、Claude 管理技能、原生通用专家与最低宿主版本 |
| `hooks/hooks.json` | 用 command + args 启动独立 Node hook，JSON 经 stdin/stdout 传递 |
| `src/claude.ts` | hook/CLI 进程入口；错误写 stderr |
| `src/extension/claude-hooks.ts` | 固定根目录、启用检查、资料组装与命令执行 |
| `resources/claude/skills/pbot/SKILL.md` | 通过原生技能执行 init、status、python setup |
| `resources/claude/agents/general-purpose.md` | 构建时由共用专家职责生成的原生 Agent 声明 |

根目录使用公开 `CLAUDE_PROJECT_DIR`；普通 Node 命令无此变量时使用 cwd。仅检查该根的 `.pbot/config.json`。缺失、false 或无效配置不准备 Python或加入业务资料。初始化沿用共用 `initializeWorkspace`，保留用户文件、`CLAUDE.md` 与未知配置字段。

| hook | 行为 |
| --- | --- |
| `SessionStart` | 已启用时检查并按需准备共享 Python；未启用时提供初始化入口 |
| `UserPromptSubmit` | 重读配置和当前资料，加入公共约定、角色、AGENTS 与环境状态 |
| `SubagentStart` | 仅为插件的 `personal-bot:general-purpose` 加入当前专家资料 |
| `PreToolUse` / `Skill`、`UserPromptExpansion` | 检查模型调用和用户直接展开的 pbot 工作方法；未启用时拦截并提供初始化提示，保留 pbot 管理技能入口 |

每次 hook 都是短生命周期进程，不保存宿主实例、心跳或租约。受管 ACP 目标用 pbot 自有环境标记跳过重复注入。宿主明确提供子代理身份时使用专家职责；独立原生团队的职责仍由 Claude 自己组织，不读取私有身份文件。

## Python 与关闭

共享环境使用现有准备脚本和锁定依赖。只读 inspect 判断是否需要准备，准备失败时在当次 hook 或命令结果中显示错误，任务上下文包含当前状态。后续 status 只检查当前环境，不持久保存安装日志。ready 状态提供完整 `python.executable`；Claude 的 Bash 按此路径运行计算。插件不修改父宿主环境，因此停用、重载和卸载无需恢复 PATH 或终止插件业务进程。

`status` 不安装依赖。`init` 和 `python setup` 运行同一准备入口，错误状态与资料初始化结果分别呈现。原生 `/personal-bot:pbot` 是模型技能；需要确定性执行时直接运行 Node 命令。

## 升级与验证

最低及当前原生检查基线是 Claude Code 2.1.325；Node 消费基线为 22.19+，完整开发使用 Linux、Node 24.9+。后续升级检查公开 hook 输入/输出、manifest、技能与专家发现，不再维护 Claude 内部记录版本白名单或大型宿主声明快照。

本地测试使用真实临时目录、Node/Python 进程及共用服务，核对固定根、停用无副作用、配置保留、错误处理和结构化 hook 输出。消费检查安装实际 tarball 并执行原生 `claude plugin validate`，另将 tarball 直接解压，在没有 node_modules 的条件下执行确定性命令、hook 和启用工作区的资料读取。原生 marketplace 缓存不安装 npm 依赖，因此解包后的 Node 入口必须独立运行。

真实模型验收在已批准且不含个人凭据的环境完成，核对：首任务资料与环境可见；工作区资料修改在下一轮生效；技能加载；原生专家职责与继续；用户选择的原生团队行为；Python 完整路径执行。无模型的进程测试与静态校验只报告实际覆盖范围，不替代这些模型行为检查。结果写任务、PR 或 CI，不维护验证日记。
