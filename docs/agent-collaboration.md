# 专家协作

Personal Bot 保留独立工作和团队工作。Pi 原生专家由 tmux 和独立进程运行，dsh 原生专家使用同进程的独立 Agent/Session；Claude 使用原生 Agent 与原生团队。Pi/dsh 可通过 ACP 委派 Pi、dsh 或 Claude，目标保留自己的上下文与原生配置。Claude 标准插件的入口见[使用指南](claude-code.md)。

本文的 `pbot_team`、轮次、批次、占用与公共消息规则适用于 Pi/dsh；Claude 原生团队由宿主管理。主模型按任务组织工作，成员原文通过对应宿主或 ACP 报告取得。

## Pi/dsh 独立工作

| pbot_agent action | 行为 |
| --- | --- |
| start | 新建上下文，可指定 name/provider/model/thinking/cwd/tools；有 message/files 时执行初始工作，否则只启动待命进程 |
| send | 向 agentId 发送 message；delivery 默认为 steer，followUp 排到当前工作之后 |
| rename | 修改名称，agentId 保持不变 |
| status/list | 查询状态或当前父会话的子会话；status 不读取报告正文，报告通过 read 获取 |
| read | 按 agentId、可选 cycleId 和 offset/limit 读取报告 |
| stop | 请求停止，保留历史 |
| resume | 用新 message 重启已停止子会话，不重放旧工作 |

每个父会话最多 50 个存活或启动、释放中的专家，包括待命实例。启动预约也占用限额。启动异步返回，不提供 wait。无任务 start 不请求模型，也不产生工作完成通知；停止未接过任务的进程不伪造失败周期。

Pi 的 start 支持 noExtensions、noSkills、noPromptTemplates 和 noContextFiles。noExtensions 默认 true，显式保留子入口及 Pi 内置 MCP、codemode、工具搜索；设为 false 时按 Pi 规则发现其他扩展。tools 遵循 Pi 原生选择。子入口只增加 pbot_team_message，不提供 pbot_agent 或 pbot_team 管理能力。

以下附件、进程模型与 TUI 说明面向 Pi；dsh 的差异见下一节。初始 files 相对工作区根目录解析。子入口在每份附件前标出绝对来源路径，保留 Pi 原生 read 的文本、图像及截断提示；未读完的附件由成员沿该路径续读。message 是唯一初始文字输入，不继承父聊天历史。

初始模型与思考级别默认继承主会话；恢复时交由 Pi 使用保存的原生模型配置，不重新传入初始模型选项。模型不可用或缺少认证时仍遵循 Pi 的原生回退与错误行为。子会话从自己的 cwd 和 Pi agent dir 取得原生配置与认证，不继承父进程临时注册的模型或 MCP。Pi 专家在启动与恢复时继承当前父进程的环境变量，终端身份由新 tmux pane 设置；父进程已删除的变量不会从 tmux server 的缓存中重新传入。环境与授权规则见[工具与执行](capability-design.md)。

## dsh 专家

dsh 使用原生 provider/model/reasoning effort，忽略 Pi 专属扩展、提示模板和上下文文件开关。创建与恢复时通过原生 composeFrom 应用父 preset，保留其文件工具、AGENTS 和技能发现；tools 使用原生能力名，专家排除协调管理及递归委派工具。noSkills 关闭模型技能目录和 skill 工具，用户显式技能手势仍按宿主处理。只在模型选择仍与父一致时继承父 effort。恢复保留原生选择，不用新父默认值覆盖旧会话。

服务器文件由原生附件存储保留内容，图片使用原生准入；Web 人工对话还接受本机文件与图片。人工对话先成功暂停所属团队，再进入原生 inbox；队列接纳、实际进入、模型消费和完成分别记录，未来排队输入不提前改变此前回答的归因。

每个专家绑定父身份与 generation。启动、校验与释放在短控制锁外等待，预约期间的停止会取消启动；旧代次不能释放新实例。原生 registry 中由其他实例持有的 Agent 不能被替换或假称释放。正常完成要求请求实际消费、持久的正常 stop 和非空最终答复。

`/pbot` Web 管理页提供人工对话、完整原生记录、停止和携新要求恢复。离页不停止已接纳工作；父 Agent 或组件关闭会暂停安排并释放其拥有的专家。重新打开页面不会恢复或重放旧工作。详情见[dsh 使用](dsh.md)。

## Claude 原生专家与团队

Claude 插件通过静态 Markdown agent 提供 `personal-bot:general-purpose`，由原生 Agent 创建专家。构建从共享职责生成该文件；工作区启用后，SubagentStart 仅为这一类型补充公共约定、工作区专家职责、根资料及工作区与资源路径。模型、effort、权限、完成通知与会话记录遵循 Claude 原生规则，pbot 不读取私有团队格式来判断成员身份。

完成后明确发送要求可继续原生专家上下文。团队需要用户在启动环境中设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，并自行选择原生 teammateMode；pbot 安装与 init 不修改开关。成员通过原生消息与任务工具交流，组织和状态由 Claude 管理。

Claude 的 resume/rewind 不恢复进程内 teammate。返回主会话后明确要求继续工作；普通子代理继续与重启后恢复团队分别遵循宿主能力，需要新建成员时保留原记录。Claude 标准插件不提供 pbot ACP、团队调度或管理面板。实际首任务上下文、技能和专家行为还需原生模型验证，见[Claude 接入设计](claude-code-design.md)。

## ACP 成员

在 start 中指定 backend，使用目标宿主的 ACP 会话：

```json
{ "action": "start", "backend": "claude", "name": "实现专家", "message": "检查项目并实现当前要求" }
```

backend 可选 pi、dsh、claude；Pi/dsh 中省略时使用当前宿主原生专家。两个主宿主共享 ACP 目标实现。目标使用自己的模型、认证、工具、技能和项目配置，恢复保留原会话的模型选择。Claude 作为 ACP 目标的能力独立于标准 Claude 插件，所需 Claude SDK 保留为可选 peer 与开发依赖。

model 和 thinking 均为可选，可单独提供；两者都省略时使用目标默认模型和默认思考等级。只指定 model 时使用所选模型的原生默认思考配置；只指定 thinking 时将该等级用于默认模型。主会话的模型和思考默认值不传给 ACP 目标。

model 支持目标的原生模型 ID，也支持 ACP 完整模型值。Pi 和 dsh 的同名模型优先使用目标当前默认提供方；仍有重名时指定 provider 或完整模型值。thinking 使用目标公开的等级 ID，支持范围随所选模型变化。例如：

```json
{ "action": "start", "backend": "dsh", "model": "deepseek-flash", "thinking": "high", "message": "检查项目并实现当前要求" }
```

首次使用前按[ACP 专家程序安装说明](../README.zh-CN.md#可选安装-acp-专家程序)准备目标程序、认证和默认模型。默认入口分别为 pi-acp、dsh --profile acp 和 claude-agent-acp；Claude 适配器需支持 ACP systemPrompt。缺少程序时，start 返回该目标的安装命令和路径配置示例，修复后重试原请求。

自定义可执行路径与 profile 参数放在工作区的 [acp 配置](workspace-configuration.md#acp-启动配置)。从源码使用 ACP 前先运行完整的 `npm run build`，以生成 worker 和 dsh 成员入口。

ACP 成员支持待命、独立委派、持续对话、状态、固定周期报告、停止和恢复。运行中的追加要求使用 followUp：

```json
{ "action": "send", "agentId": "返回的成员 ID", "message": "完成当前任务后继续检查相关调用", "delivery": "followUp" }
```

返回的 transport 为 acp，selection 给出 provider、model 和有效 thinking，包含宿主默认值。Claude 的 model 保留配置别名，resolvedModel 在原生会话报告后给出实际模型 ID；Pi 详情与 dsh 工作区页一起显示两者。Claude 的默认思考等级遵循原生环境设置，显式 thinking 只覆盖当前成员的启动配置。capabilities 给出当前能力。首批不提供运行中 steer、团队通信和完整原生记录；工具在忙碌时拒绝 steer，团队使用原生专家。Pi 专属启动开关只对 Pi 目标生效；Claude 的工具与技能通过 Claude 原生配置选择。

成员加载公共约定、general-purpose 职责、工作区同名补充及 `workspaceRoot`、`resourceRoot`，并按需使用包内技能。Claude 的原生技能目录中可见 personal-bot:provider-connections 和 personal-bot:project-maintenance，用户与项目技能继续沿用 Claude 配置。计算使用目标宿主可用的项目环境。

Pi 的 `/pbot agents` 对 ACP 成员提供任务、报告、补充要求及携新要求恢复；原生 Pi 成员继续通过 tmux 进入。dsh 专家页展示 ACP 任务与报告，也支持人工消息和附件。

Pi 权限请求进入已有确认队列；dsh 工作区页展示待确认请求，也可用 `/pbot approval` 提交选项。各入口按 generation/requestId 核对请求，取消回写 null，过期选择被拒绝。

ACP 工作由独立 worker 持有。Pi reload 保留仍启用工作区的 worker；退出、切换主会话或 dsh 父会话释放时停止所属成员。休眠后先查状态，携新要求显式继续。恢复前校验已绑定的对端会话，旧输入不重放。Pi/Claude 目标从未交付输入的空待命会话可重新建立空上下文；已经交付的会话只恢复原引用。

## Pi 原生会话与恢复入口

新建 agent 的 agentId 也是 Pi session ID。对话由 Pi 保存在原生 sessions 目录或其原生配置指定的位置，按子进程 cwd 归组；pbot 只保存控制记录和文件引用。无任务待命不伪造对话，也可能尚无 JSONL 文件。首次输入前固定路径，之后恢复只打开这个文件；文件缺失或不匹配时不新建空白替代。具体规则见[文件存储](file-storage.md)。

有对话后，成员会出现在相应项目的 `pi --resume` / `/resume` 列表，并支持 Pi 原生导出。`pi --continue` 可能选中最近活跃的子会话，不保证选中主会话；需要主会话时从列表中明确选择。

`/pbot agents` 的“进入会话”连接运行中的成员；成员已停止时，“打开原会话”加载原会话并启动待命进程，不入队新要求、不调用模型、不重放旧工作。尚无对话文件的空会话仍以原 agentId 待命。运行中不另开进程同时写同一 JSONL。停止后从原生列表打开属于普通 Pi 对话，不恢复 pbot 成员身份或团队资格；模型工具 `pbot_agent resume` 仍用于携新要求继续工作。

## Pi/dsh 团队与两种策略

一个团队固定一组成员，限于同一工作区、同一父 session 的可操作分支。一个 agent 最多属于一个未关闭团队。加入团队不创建新进程，关闭团队也不停止成员；换人时关闭旧团队，再用原 agent 创建新团队。

| mode | 执行规则 |
| --- | --- |
| roundRobin | 按成员顺序发言；上一位完成且原文保存后，才安排下一位；并发固定为 1 |
| parallel | 同轮成员按并发上限工作，可直接 post/read；本轮所有答复保存后再进入下一轮 |

默认 2 轮、15 分钟。轮数为 1–10；parallel 默认并发为成员数与 2 的较小值，可调到 1–成员数。期限可设 1–86400 秒。总发言请求数不超过成员数乘轮数，普通 post 不增加请求。

团队采用固定成员与有限轮次；轮内研究、实现、计算与审查方法由角色和技能决定。

### 工具

| pbot_team action | 行为 |
| --- | --- |
| create | name、brief、members[{agentId, role}]；仅建团队，不启动模型 |
| list/status | 查看归属、成员、当前批次、activeCount 及 unresolved 请求 |
| run | teamId、instruction、mode，可选 rounds/maxConcurrent/timeoutSeconds；开展新批次 |
| pause | 停止新增安排和领取，已领取请求继续收尾 |
| close | 已暂停或结束且没有在途工作时关闭，保留历史；不阻塞等待 |

run 要求全部成员空闲、无未消费的私人输入，并已加载可用的团队入口与通信工具。条件不满足时返回原因，不在后台等待成员就绪。

主会话与成员通过 pbot_team_message read/post 通信。post 参数为 teamId、text、可选 replyTo，正文最多 24000 字符；不允许指定 sender。成员 post 必须属于其当前团队工作，主会话可在暂停时补充信息。所有发言公开，没有私密 to 信箱。

### 使用顺序

1. 用 pbot_agent start 创建待命成员，或选择已有空闲成员。
2. 用 pbot_team create 指定成员、职责与共同目标。
3. 确认成员就绪，再 run，例如：
   `{ action: "run", teamId: "...", instruction: "分别核对证据，下一轮回应分歧", mode: "parallel", rounds: 2, maxConcurrent: 2 }`。
4. 主会话不逐条转发消息。批次结束或暂停后，用 pbot_team_message read 核对成员原文及实际产物。
5. 继续讨论须显式 run 新批次。需要私人工作时，先 pause 并等待 activeCount 为 0；必要时 stop 成员，再 send/resume。

运行中的团队占用全部成员，已领取但尚未收尾的请求也占用对应成员。私人 steer/followUp 均返回 TEAM_BUSY，不另建私人等待队列。其他未被占用的 agent 可以同时独立工作。

## 原文、上下文与公开范围

团队公共记录独立于各自私人会话。Pi 通过原 inbox 投递，在 before_agent_start 和 turn_end 的安全边界注入已署名的公共原文，不请求额外 continuation。dsh 使用原生 inbox 和 pre-step；团队领取先获得原生 maintenance 准入，人工输入待处理或当前步骤已有人工消息时不追加团队背景。空闲成员在下一次团队请求时取得信息，私人工作不自动注入新群消息。

成员任务、团队背景、自动注入的公共消息和批次通知使用 Markdown 文档。普通专家只加载公共约定与专家职责；处理团队任务时才补充共同目标、成员职责、身份、轮次及团队操作说明。本批次要求仅在成员任务输入中给出，避免重复。公共消息按 seq 分节，列出作者、回复关系与来源，正文放入保留原文的代码区块，包含代码围栏的正文也不会破坏区块边界。成员原文中的 JSON 保留原样。

read 的文本结果也使用 Markdown，同时保留工具的结构化结果。nextOffset 非空表示该条正文未读完，用同一 teamId、seq 和 offset 续读；nextAfterSeq 用于后续消息。自动注入按实际 Markdown 长度限制上下文，并用 remainingFromSeq 标明未包含的消息，从 afterSeq: remainingFromSeq - 1 继续读取。Pi 压缩不删除公共记录。

只自动公开本次团队请求正常结束后的最终答复，不广播完整历史、推理或原始工具输出。人工输入混入周期时标记 mixed 并暂停团队，不自动公开混合答复；此前显式 post 的内容保留。成员信息与人工子会话输入都不扩大原用户授权。

共享上下文不是保密隔离。成员可能已经知道私人资料；暂停、关闭或创建另一团队不会清除其记忆。需要独立复核或保密边界时使用新 agent。Bash、MCP 和扩展也不是宿主沙箱。

## 周期与保存

| 标识 | 含义 |
| --- | --- |
| agentId | 持续上下文 |
| requestId | 一条父侧输入；团队关联另存，不改变旧 AgentMessage |
| cycleId | 一次受管工作周期；Pi 以 agent_settled 收尾，dsh 以持久 turn/end 收尾，另行核对消费与最终答复 |
| teamId / runId | 团队 / 一批有限轮次，不与 Task Conductor 的标识混用 |
| seq | 团队内公共消息顺序 |

请求按接纳、消费和完成记录状态。工作结果通过对应 cycle 的报告读取；团队批次状态用于控制轮次安排。

历史报告使用固定叶节点；后续工作不覆盖旧报告。团队先保存 requestId 关联，再写原 inbox；同 ID 不重复增加序号。普通锁竞争仅重试当前进程中已知尚未发布的输入，reload 丢弃这份临时等待，不自动补发。I/O 错误使当前文件实例停止后续写入与投递。

存储责任与位置见[文件存储](file-storage.md)。0.2.0 保留现有控制字段，但不兼容旧会话位置。0.1.x 记录原地保留，不迁移或接管；先在旧版停止成员，再更新并新建 agent。

## 通知、归属与生命周期

主 agent 收到的独立子会话结果通知，以及 pbot_agent、pbot_team 和 pbot_team_message 的文本结果均使用 Markdown。列表、状态、工作周期和报告分节展示，报告保留原文；通知中的报告最多展示 2000 字符，完整内容通过 read 分页读取。工具的 structuredContent、details 与 read 收据保持原有契约。

Pi 独立周期的 read 结果进入当前分支后领取该周期通知，包括只读取部分正文的情况。dsh 以持久化的上下文消费或成功模型 read 领取；PTC 内层 read 还需根调用成功，排队仅防重，不视为已消费。人工管理页不领取模型通知。nextOffset 非空时，以同一 agentId、返回的 cycle.cycleId 和 nextOffset 续读，避免默认最新周期发生变化；status 不领取通知。团队关联周期不重复发个人完成通知；主模型只收到批次结束、暂停和收尾状态。普通 post 不唤醒主模型。团队通知按 teamId/runId/状态去重，UI 或工具 read 不领取模型通知。

Pi/dsh 的团队与受管成员均绑定父 session/分支。失去归属时暂停新安排，不向当前主分支投递结果。fork 不接管旧团队；返回原分支不会自动恢复旧批次。公共记录与外部工作不会随树导航回滚。

| 事件 | 行为 |
| --- | --- |
| 独立周期完成 | 保持 idle，可继续对话 |
| Pi 主 reload | 工作区仍启用时保留子进程并暂停团队；配置关闭或无效时停止所属专家；不续排旧批次 |
| dsh 页面关闭、刷新、重连 | 已接纳工作继续归服务端，查看不恢复旧任务 |
| dsh 父 Agent 释放、组件停用或卸载 | 暂停安排，取消预约并等待自己的专家资源释放；后续须显式恢复 |
| 主中断 | 暂停团队新增安排，已领取工作默认收尾 |
| 主退出或切换 session | 先暂停团队，再按原有约 5 秒宽限清理子进程 |
| 成员 stop/异常退出/代次变化 | 暂停依赖它的批次，保留记录，不自动 resume |
| 子 reload | 暂停团队；未完成周期或仅有领取标记的请求记为 interrupted，不重跑 |
| 到达期限 | 停止新安排和领取；子入口尽力中断自身未被人工接管的团队工作 |
| 恢复主 session | 恢复记录与通知，不自动启动旧工作 |

pause 返回时可能仍有在途请求。unresolved 区分排队、已接收、未公开、未知结果与中断等状态；只有进程确已停止或请求已经结束，才能解除在途占用。结果未知时先查原生报告和外部状态，避免重复执行。

## 界面与故障恢复

dsh 的管理界面与命令见[dsh 使用说明](dsh.md)，Claude 的原生专家、技能与恢复规则见[Claude 使用说明](claude-code.md)。下面介绍 Pi 的 TUI。

`/pbot` 打开工作区菜单。`/pbot agents` 提供专家列表、详情、会话入口、补充要求、重命名和停止；`/pbot teams` 提供团队状态、公共消息、批次及成员入口。长记录使用只读阅读页。完整报告仍通过 `pbot_agent read` 获取；非 TUI 模式保留结构化输出。

当前父会话没有团队记录时，团队恢复、暂停和调度直接返回，不申请 `.control` 锁。后台扫描遇到短暂的 `.control` 锁竞争时，在下一次扫描重试；连续至少 5 秒仍无法取得锁，包括主会话中断后暂停团队仍被锁阻塞的情况，会保留 UI 错误并通知模型。暂停未成功时，通知明确说明暂停尚未确认。报告或控制记录读取失败也会通知模型。同一持续故障在当前分支去重；恢复要求升级时补发一次通知。主会话中断期间延后投递，恢复输入后再通知。

通知按实际服务状态说明恢复方式：锁释放后自动恢复扫描；可恢复的读取错误先排障，修复后由后台重试；团队服务或协作存储已停用时，修复文件仍不能恢复当前实例，须请用户在当前 Pi 会话执行 `/reload`。重载前不反复调用 pbot_team，可通过 pbot_agent list/status/read 核对仍可读取的成员状态与报告；重载后再用 pbot_team status 与 pbot_team_message read 核对团队。完整扫描成功且待暂停、待入队操作不再受阻后清除故障状态。当前实例中已恢复的故障若曾在当前分支通知，会补发一次关联的恢复消息；中断期间延后投递，成员结果优先交付。未投递的故障不补发恢复消息，重载不追认旧实例的恢复。通知不重发任务、不删除锁，命令和工具的错误仍直接返回。

进入成员前提示返回快捷键，团队成员使用相同入口。默认 tmux 绑定下，普通终端按 Ctrl+B 后按 d 脱离；主会话已在 tmux 中时，按 Ctrl+B 后按小写 l 切回。自定义绑定以自己的配置为准。返回不停止成员，不要用 /exit 代替。
