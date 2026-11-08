# 模型上下文

本文说明 Personal Bot 的指令来源、加载时机与更新方式。编写要求见[模型指令编写原则](model-instruction-guidelines.md)。宿主系统提示、用户配置和模型传输由 Pi 或 dsh 管理。

## 内容与来源

| 内容 | 来源与加载条件 |
| --- | --- |
| 公共约定、资料目录用途 | `resources/prompts/workspace.md`，主会话与专家均加载 |
| 协调者与专家职责 | `resources/agents/`，叠加原工作区 `agents/` 中的同名补充 |
| 团队目标、职责与公开范围 | 专家处理团队任务时加载 `team-member.md` 和本次团队资料 |
| 参数、分页与结果语义 | 工具契约 |
| 项目维护、工具接入 | 原生技能目录提供发现入口，正文按任务读取 |
| 计算方法 | 普通计算读取 compute；指标与回测另读 compute-finance |
| 周期、DAG 与持久任务 | 按需读取 Task Conductor 参考和上游技能 |
| 历史摘要 | 专用提示与本次问答或下层摘要 |

公共内容说明职责和日常操作，专门方法按需加载。宿主维护原生 AGENTS、技能发现和上下文去重。目录用途保留在首轮上下文中，已有用户布局与约定优先。

## Pi

主会话保留 Pi 原生系统提示、工具、AGENTS、技能目录和 cwd，再加入公共约定、协调者职责、工作区补充和环境状态。专家使用 general-purpose 职责；原生资料由专家 cwd 决定，pbot 职责补充从原工作区读取。

包内技能由 `package.json` 的 `pi.skills` 声明，遵守 no-skills 和包级过滤；专家使用自己的 noSkills 选项。技能与提示模板正文在读取或展开时加入。

`before_agent_start` 完整读取公共约定与角色后更新 section，读取失败取消本轮。角色补充在下一工作周期刷新；原生 AGENTS 与技能目录经 `/reload` 更新。`/pbot init` 创建的根 AGENTS 在重载或下次启动后加载。

未变的 section 沿用，变更通过原生差量更新，有效系统内容随后续请求传递。团队公共消息按 teamId、seq 和当前分支去重，在安全边界补充新消息；压缩后需要的原文通过团队 read 读取。

## dsh

专家在创建和恢复时通过原生 `composeFrom` 应用父会话 preset，再限制工具，保留团队通信并排除协调管理与递归委派工具。标准 preset 提供文件工具、AGENTS 与技能发现。

公共约定和角色在 `system-prompt/assemble` 当次读取。显式 complete persona 按宿主规则覆盖普通提示 section，其完整行为要求由该 persona 提供。

包内技能在 Host 层注册一次。项目和用户技能沿用原生 provider 的目录优先级与文件更新监听。noSkills 关闭专家的模型技能目录和 skill 工具；用户显式技能命令按宿主规则处理。

普通请求包含宿主提示、pbot 约定与角色、工具声明，以及原生 AGENTS、环境与技能目录。未变的原生内容沿用；PTC 的工具目录和 run_code 由宿主管理。

团队简报在 `pre-step` 已接纳的团队上下文中加入，每次团队发言一次。首轮即提供目标、成员职责与操作说明，公共消息序号在实际消费后确认。准入失败保留未读状态；人工输入不追加新团队内容。

## 环境与历史

模型环境提供 `workspaceRoot`、`resourceRoot`、`python.state` 和就绪时的 `python.directory`。实际 cwd 由宿主提供，Python 准备日志在 `/pbot status` 查看。

两种宿主的历史摘要均使用 `resources/prompts/history-summary.md` 与当前问答或下层摘要，附带时段和未完成标记。该调用不提供工具或普通会话上下文。长文本按预算分段汇总，完整原文保留；查询和资源加载不触发摘要。
