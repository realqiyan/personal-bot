# Claude Code 标准插件接入

Claude 接入聚焦工作区资料、专业技能与原生通用专家。使用公开的 command hooks、Markdown skills 和 Markdown agents；主会话、原生工具、MCP、团队和恢复由 Claude 管理。使用操作见[Claude 指南](claude-code.md)，共用模块见[技术设计](technical-design.md)。

## 范围与依赖

Claude 插件不实现 pbot 面板、历史采集与检索、摘要、ACP 委派或 pbot 团队调度。Pi/dsh 的历史和 ACP 保留，其中 Claude 作为 ACP 目标的 SDK 适配继续由 ACP 模块负责。现有归档、控制记录和备份保留；持久合同不因功能收敛而迁移。

插件不依赖 function-hooks/mod、`claude-code` 类型声明、Node MCP server、内部 transcript、私有团队配置、父进程启动参数或原生消息收据。Claude hooks 使用 Node 内置模块和共用工作区服务。Claude SDK 仍是 Pi/dsh 的 Claude ACP 目标所需可选 peer 与精确开发依赖，Claude 插件本身不加载它。

## 入口与行为

| 入口 | 责任 |
| --- | --- |
| `.claude-plugin/plugin.json` | 声明共用技能、Claude 管理技能、原生通用专家与最低宿主版本 |
| `hooks/hooks.json` | 用 command + args 启动独立 Node hook，JSON 经 stdin/stdout 传递 |
| `src/claude.ts` | hook/CLI 进程入口；错误写 stderr |
| `src/extension/claude-hooks.ts` | 固定根目录、启用检查、资料组装与命令执行 |
| `resources/claude/skills/pbot/SKILL.md` | 通过原生技能执行 init、status |
| `resources/claude/agents/general-purpose.md` | 构建时由共用专家职责生成的原生 Agent 声明 |

根目录使用公开 `CLAUDE_PROJECT_DIR`；普通 Node 命令无此变量时使用 cwd。仅检查该根的 `.pbot/config.json`。缺失、false 或无效配置不加入业务资料。初始化沿用共用 `initializeWorkspace`，保留用户文件、`CLAUDE.md` 与未知配置字段。

| hook | 行为 |
| --- | --- |
| `UserPromptSubmit` | 重读配置和当前资料，加入公共约定、角色、AGENTS 及工作区与资源路径 |
| `SubagentStart` | 仅为插件的 `personal-bot:general-purpose` 加入当前专家资料 |
| `PreToolUse` / `Skill`、`UserPromptExpansion` | 检查模型调用和用户直接展开的 pbot 工作方法；未启用时拦截并提供初始化提示，保留 pbot 管理技能入口 |

每次 hook 都是短生命周期进程，不保存宿主实例、心跳或租约。受管 ACP 目标用 pbot 自有环境标记跳过重复注入。宿主明确提供子代理身份时使用专家职责；独立原生团队的职责仍由 Claude 自己组织，不读取私有身份文件。

## 命令与停用

`init` 补建工作区资料并启用共用配置；`status` 只读取工作区和配置状态。原生 `/personal-bot:pbot` 是模型技能；需要确定性执行时直接运行 Node 命令。

停用配置后停止后续业务资料注入与工作方法调用。原生会话、团队及插件卸载由 Claude 管理，已有环境、用户资料、历史与备份保留。计算通过原生 Bash 使用项目环境，方法按任务读取。

## 升级与验证

最低及当前原生检查基线是 Claude Code 2.1.325；Node 消费基线为 22.19+，完整开发使用 Linux、Node 24.9+。后续升级检查公开 hook 输入/输出、manifest、技能与专家发现，不再维护 Claude 内部记录版本白名单或大型宿主声明快照。

本地测试使用真实临时目录、Node 进程及共用服务，核对固定根、停用无副作用、配置保留、错误处理和结构化 hook 输出。消费检查安装实际 tarball 并执行原生 `claude plugin validate`，另将 tarball 直接解压，在没有 node_modules 的条件下执行确定性命令、hook 和启用工作区的资料读取。原生 marketplace 缓存不安装 npm 依赖，因此解包后的 Node 入口必须独立运行。

真实模型验收在已批准且不含个人凭据的环境完成，核对：首任务资料与工作区、资源路径可见；工作区资料修改在下一轮生效；技能加载；原生专家职责与继续；用户选择的原生团队行为。无模型的进程测试与静态校验只报告实际覆盖范围，不替代这些模型行为检查。结果写任务、PR 或 CI，不维护验证日记。
