# 模型上下文

Personal Bot 分别接入 Pi、dsh 和 Claude Code 原生主会话。Pi/dsh 也可将三者作为 ACP 目标。本文说明指令来源、加载时机与更新方式；编写要求见[模型指令编写原则](model-instruction-guidelines.md)。Claude 的模型上下文、技能调用与原生专家行为还需在批准的原生模型环境验证，范围见[Claude 接入设计](claude-code-design.md)。

## 内容与来源

| 内容 | 来源与加载条件 |
| --- | --- |
| 公共约定、资料目录用途 | `resources/prompts/workspace.md`，启用的主会话与专家加载 |
| 协调者与专家职责 | `resources/agents/`，叠加原工作区 `agents/` 中的同名补充 |
| 协调者操作导航 | Pi/dsh 加载 `resources/prompts/native-coordinator.md`，Claude 加载 `resources/prompts/claude-coordinator.md` |
| pbot 团队目标、职责与公开范围 | Pi/dsh 专家处理团队任务时加载 `team-member.md` 和本次团队资料 |
| 参数、分页、能力与结果语义 | Pi/dsh 工具契约，按所选程序和 capabilities 说明操作 |
| 工作区初始化与状态 | Claude 原生 `resources/claude/skills/pbot/SKILL.md` 调用 Node CLI |
| 项目维护、工具接入 | 原生技能目录提供发现入口，正文按任务读取 |
| 计算方法 | 普通计算读取 compute；指标与回测另读 compute-finance |
| 周期、DAG 与持久任务 | 按需读取 Task Conductor 参考和上游技能 |
| 历史摘要 | Pi/dsh 专用提示与本次问答或下层摘要 |

公共 coordinator 文档保存共有职责，各宿主组合自己的操作导航与工作区补充。Claude 导航使用原生 Agent/teams、技能和 CLI；Pi/dsh 导航保留 pbot 专家、团队与历史工具。

公共内容说明职责和日常操作，专门方法按需加载。目录用途保留在首轮上下文中，已有用户布局与约定优先。

## Pi

工作区通过 `.pbot/config.json` 显式启用后，主会话保留 Pi 原生系统提示、工具、AGENTS、技能目录和 cwd，再加入公共约定、协调者职责、Pi/dsh 操作导航、工作区补充及工作区与资源路径。未启用时只保留状态和初始化入口，不创建 pbot 实例，不注册业务工具、提示词或包内技能。专家使用 general-purpose 职责；原生资料由专家 cwd 决定，pbot 职责补充从原工作区读取。

已启用的 Pi 主会话通过 `resources_discover` 提供包内技能路径，由原生加载器读取，遵守 CLI `--no-skills` 和包级过滤；专家使用自己的 noSkills 选项。技能与提示模板正文在读取或展开时加入。

`before_agent_start` 完整读取公共约定与角色后更新 section，读取失败取消本轮。角色补充在下一工作周期刷新；原生 AGENTS 与技能目录经 `/reload` 更新。`/pbot init` 首次启用时自动重载并加载新建根 AGENTS；已启动时补建的根 AGENTS 经 `/reload` 加载。

未变的 section 沿用，变更通过原生差量更新，有效系统内容随后续请求传递。团队公共消息按 teamId、seq 和当前分支去重，在安全边界补充；压缩后需要的原文通过团队 read 读取。

## dsh

专家在创建和恢复时通过原生 `composeFrom` 应用父会话 preset，再限制工具，保留团队通信并排除协调管理与递归委派工具。标准 preset 提供文件工具、AGENTS 与技能发现。

公共约定和角色在 `system-prompt/assemble` 当次读取，协调者组合 Pi/dsh 操作导航。显式 complete persona 按宿主规则覆盖普通提示 section，其完整行为要求由该 persona 提供。

只有已启用工作区的主会话及受管专家注册包内技能 provider。项目和用户技能沿用原生 provider 的目录优先级与文件更新监听，包内方法让位于继承的同名方法。noSkills 关闭专家的模型技能目录和 skill 工具；用户显式技能命令按宿主规则处理。

普通请求包含宿主提示、pbot 约定与角色、工具声明，以及原生 AGENTS、环境与技能目录。未变的原生内容沿用；PTC 的工具目录和 run_code 由宿主管理。

团队简报在 `pre-step` 已接纳的团队上下文中加入，每次团队发言一次。首轮提供目标、成员职责与操作说明，公共消息序号在实际消费后确认。准入失败保留未读状态；人工输入不追加新团队内容。

## Claude Code

Claude 自己加载原生系统提示、`CLAUDE.md`、用户规则、工具、其他插件、技能和 Markdown agent。pbot 使用 `hooks/hooks.json` 中的标准 command hooks，由 Node 进程读取固定在 `CLAUDE_PROJECT_DIR` 的工作区根与 `.pbot/config.json`。

| 入口 | 加载行为 |
| --- | --- |
| UserPromptSubmit | 已启用时读取公共约定、共有协调者职责、Claude 操作导航、工作区 `agents/coordinator.md`、根 `AGENTS.md` 及宿主与路径环境；未启用或配置无效时不注入模型上下文 |
| SubagentStart | 仅对 `personal-bot:general-purpose` 加载公共约定、专家职责、工作区 `agents/general-purpose.md`、根资料及工作区与资源路径 |
| PreToolUse / Skill、UserPromptExpansion | 检查模型调用和用户直接展开的 pbot 工作方法；未启用或配置无效时拦截并给出初始化入口，保留 `personal-bot:pbot` 初始化技能可用 |

`resources/claude/agents/general-purpose.md` 在构建时从共享职责生成，原生 Agent 负责启动与完成。SubagentStart 按确切 agent 类型补充工作区资料，不读取私有团队文件或父进程参数来推断身份。其他原生专家及团队沿用 Claude 自己的上下文规则。

根 `AGENTS.md` 通过 hook 提供，pbot 保留用户 `CLAUDE.md`。公共约定、职责与工作区补充在下一次相应 hook 执行时读取当前内容。插件不检查或解析私人 transcript。

原生 `/personal-bot:pbot init`、`status` 是技能请求，模型通过 Bash 调用 `node <plugin>/lib/claude.js` 的同名操作。需要确定性执行时可直接调用该 CLI。包内工作方法使用原生静态技能发现，未启用时仍可显示名称和简介。

Claude 环境提供 `host`、`workspaceRoot` 与 `resourceRoot`，脚本通过原生 Bash 按项目约定运行。Claude 会话、原生团队通信、完成通知与恢复由宿主管理；pbot 不采集或查询新的 Claude 历史，也不生成自动摘要。

## ACP 成员

Pi 和 dsh 的 ACP 成员使用专用入口加载公共约定、general-purpose 职责、工作区补充及工作区与资源路径，并使用各自原生资源发现。入口不消费 pbot inbox，输入由 ACP worker 投递。Pi 的 before_agent_start 刷新 section；dsh 的 system-prompt/assemble 刷新原生 section。

Pi/dsh 委派的 Claude ACP 子代理通过协商后的 systemPrompt append 加入同一公共约定、职责及工作区与资源路径。包内 `resources/skills/` 作为该子会话的原生本地插件注册，技能元数据进入 Claude 目录，正文按需读取；该插件清单只声明技能。原生 CLAUDE、用户与项目技能、工具由 Claude 自己加载。恢复时重新提供 pbot 内容和插件路径。ACP 成员只处理独立工作，不加入 pbot 团队上下文。

协议流中的 thought 和工具进度用于活动状态，Pi/dsh 的最终答复按原生完成边界提取，Claude 按消息 ID 和 prompt 完成边界定稿。

## 环境与历史

各宿主的 pbot 模型环境提供 `host`、`workspaceRoot` 与 `resourceRoot`，实际 cwd 由宿主提供。公共提示保留资料目录用途，计算方法按任务读取；解释器与依赖沿用项目约定。

Pi/dsh 历史摘要只接收 `resources/prompts/history-summary.md` 与当前问答或下层摘要，附带时段和未完成标记，不提供工具或普通会话上下文。长文本按预算分段汇总，完整原文保留；查询、面板和资源加载不触发摘要。
