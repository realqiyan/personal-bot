# Subagent 升级方案：独立工作与团队协作

状态：独立模式与两种团队策略在 0.1.3 实现，双成员真实模型单轮冒烟已通过。0.2.0 保留这套执行链路，将子会话 JSONL 交给 Pi 原生存储，不兼容或迁移旧会话布局；此项调整仅做本地 SDK 与无认证进程验证。剩余验收见[验证](validation.md)。当前用法见[专家协作](agent-collaboration.md)。本方案遵循奥卡姆剃刀原则：复用现有运行链路，只补团队必需的规则，不以重构执行器为前置条件。

## 1. 收敛范围与版本

保留两种工作方式：独立委派与持续对话；成员直接交换原文的团队协作。仍由 tmux 和独立 Pi 进程运行成员，不增加协调者模型或后台服务。

团队增量最初采用 **0.1.3**，未更改原有控制字段。随后按用户要求取消旧会话位置兼容，改由 Pi 管理对话文件，因此当前版本为 **0.2.0**。这只改变会话定位与恢复契约，不引入先前被删去的统一队列、事件日志或执行器重构。

| 上一版的复杂点 | 本版处理 |
| --- | --- |
| 新增 AgentRuntimeService，改造统一 WorkRequest 队列 | 删除；保留 AgentService、现有 inbox 与子入口 pump |
| 修改 AgentMessage、AgentCycle 的持久结构 | 不修改；团队关联存入独立团队记录 |
| 团队事件日志、快照和重建 | 删除；一个 team.json 作为唯一团队事实来源，原子更新 |
| 多层锁与成员 membershipId | 删除；复用现有控制锁，首版固定团队成员 |
| 动态 ask、返回唤醒、次数预留 | 暂缓；先实现轮流讨论和并行轮次 |
| uncertain 的独立状态机与 resolve 工具 | 删除；异常暂停，不自动重跑，核查后显式开展新一批工作 |
| 私人工作与团队工作混合排队 | 不做；团队运行期间独占成员，暂停收尾后才能切换 |
| 新增团队扫描器与定时器 | 不做；复用父侧 1 秒扫描和子侧 250 毫秒 pump |
| 新建复杂团队 TUI | 不做；先用 Pi 原生列表、输入与查看对话框 |
| 先升级 Pi 再开发 | 团队最初在 Pi 1.1.0 验证，不以升级为前提；当前依赖已升级至 1.4.0 |

首版限于同一工作区、同一父 session，一个 agent 最多属于一个未关闭团队。成员在 create 时确定；需要换人时关闭旧团队、用原 agent 创建新团队，历史保留。团队关闭不停止成员，成员仍可继续独立工作。

这不是无边界的自由 swarm：成员能直接读写公共消息，代码按有限轮次请求回应。动态点名唤醒、热增减成员、跨团队私信、多机通信和任务 DAG 等出现明确需求后再设计，不预留通用插件接口。

## 2. 现有代码如何复用

主链路不变：

```text
pbot_agent → AgentService → AgentFiles.inbox → 子入口 pump
                                       ↓
                           Pi 原生会话与完成记录
                                       ↓
                            原有父侧扫描与通知
```

团队在这条链路旁增加一份记录：

```text
pbot_team → TeamService → team.json（成员、轮次、公共消息）
                              ↓ 生成普通父侧发言请求
                  AgentService.enqueueTeam → 原 inbox
                              ↓
                子入口注入团队原文，执行既有任务链路
                              ↓
             父侧读取既有 completion → 保存公开答复 → 下一位/轮
```

主模型不读取、改写后再转发成员发言。父进程运行调度代码即可，主模型可以同时处理其他独立任务。

保留现有模型、cwd、工具、MCP、技能、Python、50 个存活子进程上限、分支归属和 stop/resume 规则。没有团队记录时，原独立流程保持原样。

## 3. 最小数据与存储

### 3.1 不改旧持久契约

以下结构保持字段和含义不变：AgentDescriptor、AgentLaunch、AgentMessage、AgentStatus、AgentCycle。

团队发言请求也是父侧发起的请求，继续使用已有 requestId、generation、sequence 和 cycle.requestIds。cycle.source 仍为 parent/interactive/mixed，不增加 team 枚举。是否属于团队，通过 requestId 查团队记录，而不是从提示词中解析。

原子 JSON、文件路径校验与目录权限继续复用，不加哈希校验、存储版本计数或迁移代码。

### 3.2 原生对话与独立控制记录

```text
当前 Pi agent dir/
├── sessions/<Pi 编码的 cwd>/<时间戳>_<agentId>.jsonl
└── pbot/
    ├── subagents/<agentId>/
    │   ├── 原有 descriptor、launch、inbox、status、completions
    │   ├── session-ref.json   # 原生文件引用；首次输入前为 null
    │   └── team-ready.json    # 仅表示当前代次支持团队接入
    └── teams/<teamId>/team.json
```

sessions 的实际位置遵循子进程的 Pi 原生配置。新建使用 `--session-id <agentId>`，首次输入前固定文件引用，恢复使用 `--session <绝对路径>`。pbot 不生成原生文件名、不复制 JSONL，也不为了空待命会话落盘而伪造消息。完整规则见[文件存储](file-storage.md)。

team.json 的领域结构如下。嵌套数据不是独立服务或另一套执行框架。

```ts
interface TeamRecord {
  teamId: string;
  release: string;
  workspace: string;
  parentSessionId: string;
  parentLeaf: string | null;
  name: string;
  brief: string; // 目标、范围、交付要求；不是新增执行授权
  closed: boolean;
  members: { agentId: string; role: string }[];
  runs: {
    runId: string;
    instruction: string;
    mode: "roundRobin" | "parallel";
    rounds: number;
    maxConcurrent: number;
    deadlineAt: number;
    generations: Record<string, string>; // 本批次成员的既有启动代次
    state: "running" | "paused" | "finished";
    reason?: string;
    issued: {
      requestId: string;
      agentId: string;
      generation: string;
      round: number;
      throughSeq: number;
    }[];
  }[];
  messages: {
    seq: number;
    operationId: string;
    author: { kind: "user" | "coordinator" | "member"; agentId?: string; name: string };
    text: string;
    replyTo?: number;
    runId?: string;
    source?: { requestId: string; cycleId: string };
  }[];
}
```

- issued 只记已安排的请求及关联，不复制 accepted、running、completed 等 agent 执行状态；这些继续从 status/completions 读取。
- run 保存成员现有 generation 的快照，不引入新的代次计数；stop/resume 后的新代次不能接管旧批次。
- 每个 runId 下，每位成员每轮最多一个 requestId。轮次进度由 issued 和完成记录计算，不再维护一套调度游标。
- messages 只增不改。seq 在锁内递增；replyTo 引用同一团队的消息序号。
- operationId 用于同一发布操作去重；最终答复使用关联 requestId 的固定操作 ID。并非按正文相似度去重。
- 作者由入口绑定。模型不能指定自己是用户或冒充其他成员。
- 单文件适合首版短时、小团队讨论，避免跨文件提交协议。暂不做分片、归档或自动清理；有实际规模问题后再调整。
- 一次扫描只读取相关团队快照一次并建立 requestId 索引，不在每条 inbox 消息上重扫全部团队。写操作仍在锁内重新读取，不把过期快照覆盖回文件。

team-ready.json 只含 `{ generation, ready }`。新子入口完成注册后写 ready=true，关闭或 reload 前写 false。父侧要求标记代次与 launch 一致且进程存活。它不是 schema 版本或工作区启用开关。

同一兼容线内缺少就绪标记的成员不能接团队请求，可在空闲时 reload 子入口或 stop/resume。0.1.x 使用旧会话布局，不能通过 reload 或 resume 接入 0.2.0；更新前停止旧进程，再新建成员。不重启旧任务，不改写旧 descriptor.release。

## 4. 工具契约

### 4.1 pbot_agent：仅作局部扩展

- 原 action 保留，独立模式的 send/steer/followUp 语义不变。
- start 未提供 message/prompts/files 时只启动待命进程，不 enqueue、不调用模型。返回值不含 requestId/messageStatus，原 schema 已允许这两个字段缺省。
- 无初始请求的待命进程被停止时，不生成“任务交付前退出”的虚假失败。
- 团队正在运行或该成员还有已领取的团队请求未收尾时，私人 send 返回 `TEAM_BUSY`，无论 steer 还是 followUp；不另建私人等待队列。
- read/status/rename/stop 仍可使用。stop 使相关团队批次暂停；resume 仍须新要求，不恢复旧团队请求。

用户切换工作方式的路径是：`pause → 等在途工作结束，必要时 stop → 独立 send/resume`。其他未被团队占用的 agent 始终可以独立工作。

### 4.2 pbot_team：主会话管理

| action | 参数与行为 |
| --- | --- |
| create | name、brief、members[{agentId, role}]；固定成员，不创建子进程，不启动模型 |
| list/status | 查询当前父会话的团队，显示归属、成员状态、轮次、在途请求和结束原因 |
| read | teamId、afterSeq、limit；也可按 seq 与 offset/limit 读取单条长消息 |
| run | teamId、instruction、mode、rounds、maxConcurrent、timeoutSeconds；启动新批次 |
| pause | teamId；停止新的领取与安排，不中断已领取请求 |
| close | teamId；仅在已暂停/结束且无在途工作时关闭，否则返回忙碌状态；不阻塞等待，保留全部记录 |

run 的建议默认值为 2 轮、15 分钟；rounds 首版限定 1–10。roundRobin 的并发固定为 1；parallel 默认并发为成员数与 2 的较小值，可在 1–成员数之间调整。总请求数最多为成员数乘轮数，没有额外回调次数预算。

run 的前置条件：团队可操作、未关闭、没有其他运行批次或仍在执行的旧团队请求；所有成员属于当前可操作分支、进程空闲、没有未消费的普通 inbox 输入，且 team-ready 有效。条件不满足直接返回具体成员与原因，不引入“等所有人就绪”的后台任务。

post 使用工具调用 ID 或 UI 操作 ID 去重，任务入队按 requestId 去重。create/run 的写入结果不明时先查询 list/status，不自动再次创建；不为此增加通用操作登记表。调用返回只表示记录/请求已保存，不表示模型完成。

### 4.3 pbot_team_message：公共通信

只保留 read/post。主会话与成员都可使用，read 复用团队读取实现。

post 参数为 teamId、text、可选 replyTo。正文沿用现有消息量级上限 24000 字符；长证据引用工作区文件。所有成员可读同一公共记录，不提供伪装成私信的 to 参数。

成员入口绑定 agentId/generation；成员发言限于自己的团队工作。主会话可以在团队暂停时补充公共信息，再通过 run 请求下一批回应。普通 post 不启动模型、不改变轮次、不触发主模型处理。

读取返回 seq、作者、原文、回复关系与分页信息。正文截断必须标明剩余位置；不得把展示摘要当作完整记录。首版不提供 ask、wait 或自动返回唤醒。

## 5. 请求投递：沿用 inbox，先关联后发布

### 5.1 仅一个控制锁

复用 `AgentFiles.control()`，团队修改、团队输入的领取、普通 send 的占用检查均使用该锁。TeamFiles 不再创建第二种锁。所有操作短时同步完成；锁内不等待模型、认证、进程退出或 UI。

这保证两个关键顺序：

1. 两个团队不能同时占用同一个 agent。
2. pause 与子侧领取有确定先后；先领取的算在途，先 pause 的不再领取。

普通锁竞争由下一次扫描重试，不重发工作。实现时只把建锁的 EEXIST 作为占用，并补充稳定错误码；权限、磁盘等错误直接失败，不靠中文报错文本分支。坏文件和崩溃遗留锁仍报错，不自动删锁。

### 5.2 父侧安排一位成员

1. TeamService 根据现有完成记录选出下一位或本轮可并行的成员。
2. 锁内再次检查团队状态、分支资格、成员 generation、空闲情况和期限。
3. 生成 requestId，把 agentId/generation/round/throughSeq 写入 team.json 的 issued，原子保存后释放锁。
4. 调用 AgentService 新增的窄方法 enqueueTeam；该方法再次在锁内检查关联、团队状态、generation 和 team-ready 仍有效，再使用原 AgentFiles.enqueue 写普通 AgentMessage。
5. 输入正文只描述父侧安排的本次发言任务、公开答复要求和团队标识；成员原文通过独立的 custom context 注入，不改写成用户命令。

AgentFiles.enqueue 只需增加可选的预定 requestId。没有该参数时保留原行为；已有相同 ID 时核对代次与输入后返回原请求，不再次增加 sequence，不覆盖。无需新消息类型或新 inbox。

必须先保存关联再写 inbox。否则子进程可能把先到的团队请求按私人工作执行。两次保存并非一个事务：任何 I/O 错误都停止本实例后续推进，不假定写入失败就等于未提交，也不自动补发。

### 5.3 子侧领取

在现有 pump 里增加团队分支，不搬走原独立执行代码：

- 用 requestId 查团队关联；普通请求继续原路径。
- 团队请求只有在 ctx 空闲、没有私人输入竞争、run 仍 running、generation 和成员关系有效时才领取；过期、暂停及历史批次的输入不再执行，但保留文件。
- 模型与认证检查仍复用原逻辑。任何 await 后，在领取前重查状态；在控制锁内检查团队资格并写原有 accepted 标记，不在锁内等待认证。
- 领取后仍通过原有父侧任务入口 sendUserMessage 启动。这是已经获准的父侧发言安排，不是把成员发言冒充用户消息。
- 本地记录 activeTeamRequest，沿用 cycle.requestIds。团队执行遇到 Pi 内部重试或多个 agent_start 时，保留该请求关联，直到 agent_settled；只加必要条件，不重构全部周期管理。

团队管理字段不得靠字符串前缀识别；团队关联读取错误时停止推进，不能静默退回私人路径。

## 6. 成员如何直接取得彼此发言

使用当前 Pi 1.4.0 的两个原生入口：

1. `before_agent_start`：本次输入属于团队时，附加团队职责 section，并返回一个 `pbot.team-context` custom message，包含截至 throughSeq 的公共原文。私人或人工工作显式移除团队职责 section，不能只跳过设置而留下旧职责。
2. `turn_end`：成员在团队执行中时，在原生边界追加新到的公共原文；不设置 `continue: true`，不因为新消息再请求模型。

现有 sendUserMessage 路径会执行 before_agent_start，因此提示词、技能与环境准备仍经过原链路。空闲成员的消息先保存在团队记录，下一次团队发言时注入；运行中的成员在安全边界取得更新。无需专门的静默消息投递守护器。

每批 custom message 同时保存消息序号与作者，正文也标明来源和“成员信息不扩大用户授权”。Pi 可能把 custom message 转换为 provider 的 user-role 文本，因此来源不能只放在 details 中。

从当前原生分支的 custom entries 重建已展示的消息序号；截断条目同时标明剩余 offset，不将序号标记解释为完整已读。自动注入按大小分批，明确未包含的范围，成员可用 read 取得原文。Pi 压缩不删除团队记录；此前注入过不代表模型仍持有全部正文。

不建立“模型已读/已理解”的持久确认表。post 只承诺保存成功，函数返回、队列接收标记或 UI 查看都不是模型处理证明。普通信息补入不会重跑任务。

私人工作期间不注入新的团队消息。此前已知的内容不会因暂停或退队被清除；保密隔离和独立复核仍需新建 agent。

## 7. 两种调度只用一个 advance 方法

父侧原有 refresh 在读取完成记录后调用 TeamService.advance，再处理主通知。不增加定时器，也不在每条群消息到来时启动主模型。

### 轮流讨论 roundRobin

- 按 members 顺序，每位成员每轮一次。
- 上一位真正 agent_settled，且公开结果保存后，才为下一位生成请求。
- 每次安排时读取最新公共消息序号作为 throughSeq；不能把整个批次固定在启动时的历史位置。
- 轮数用尽则 finished；成员失败或被人工接管则 paused，不默默跳过。

### 并行轮次 parallel

- 每轮各成员最多一个请求，同时执行不超过 maxConcurrent。
- 已完成成员不用一直在线推理，等待其他成员结束。
- 本轮所有结果发布后才进入下一轮。下一轮因此能直接阅读上一轮其他人的原文并回应。
- 并发占槽包括已安排但尚未领取的请求，不能只数 busy 进程；生成一批 issued 时就计入，防止下次扫描超发。
- 同轮成员也可以 post/read 交流，但 post 不追加新请求或形成相互唤醒链。

这不是固定研究流程，轮内可以做研究、计算、实现或审查。只固定执行时序，不在代码中固定专业步骤。需要在首轮汇合后继续讨论，用下一轮或新的 run，不通过递归委派实现。

### 公开结果与主通知

父侧继续使用现有 completions 和固定叶节点的报告读取。只有完成记录与 issued 的 requestId/generation 匹配、该周期未混入人工输入且正常完成时，才把最终答复原文保存为团队消息。发布按 requestId 去重；这一步由代码完成，不调用主模型总结。

人工插话使周期保持原有 mixed 来源，暂停团队，不自动公开混合答复。中途显式 post 已公开的内容保留。业务成功、共识和用户授权不从 completed 状态推导。

已关联团队的周期不再同时走逐个 agent 的自动完成通知。主模型只收到批次结束、暂停/失败及所需处理事项；收据沿用原生父会话与分支检查，按 teamId/runId/结果事件去重。用户仍可通过 pbot_agent read 查看成员报告。

## 8. 暂停、恢复和故障规则

这里选择保守且容易实现的规则，不建立通用恢复状态机。

| 情况 | 处理 |
| --- | --- |
| 用户 pause 或主侧中断 | 保存 paused，禁止新增安排和领取；已领取的工作继续收尾 |
| 需要立即停止在途成员 | 使用现有 pbot_agent stop；不再增加另一套 cancel 工具 |
| 成员失败、停止、代次变化 | 暂停批次，显示现有状态与报告，不自动 resume |
| 主 reload | 团队暂停；保留子进程及在途结果，不自动续排。独立模式原有 reload 行为不变 |
| 主退出或切换 session | 先暂停团队，再执行现有子进程清理 |
| 主 session 恢复、子 reload 或异常退出 | 恢复记录，核对已有完成事件，不自动重跑旧批次 |
| 父分支失去团队或成员归属 | 暂停新增调度与主模型结果投递；在途结果仍可保存 |
| 达到 deadlineAt | 不再安排/领取；子入口仅中断自己当前且未被人工接管的团队工作，不停止无关私人工作 |
| close | 要求没有仍在执行的团队工作；关闭后只读，不删除记录、不停止 agent |

pause 返回时可能还有在途请求；status 明确显示它们。只有它们已结束或进程确已停止，才能开始新的独立工作或新的团队批次。暂停批次中尚未领取的输入不再占用成员；它们保留在 inbox，但子入口按旧 run 关联跳过，不能阻塞后续私人输入。

继续讨论用新的 runId、新 instruction 和新的有限轮数。旧批次保留原状，不把旧 requestId 重置为待执行。对于无法确认的历史执行结果，先查原生报告和外部状态；新 run 不是“自动重试失败步骤”。

### 三个崩溃窗口

| 窗口 | 恢复动作 |
| --- | --- |
| 团队关联已保存，inbox 尚未写入 | 团队暂停，展示未收到结果的安排；不在恢复时自动补发 |
| accepted 已写，模型是否执行不明 | 保留未知事实、暂停；不能据此判断已完成，也不能重新执行旧请求 |
| completion 已保存，公开答复尚未保存 | 可以根据原固定报告补交付，按 requestId 去重；不调用模型 |

同一原则适用于原子发布后的 I/O 错误：停止后续写入和发起工作，不因再次读取成功就假定上一次没有副作用。

## 9. 具体改动清单

新增领域模块限于一份数据定义、一个服务和一个存储文件。工具与简单命令按现有分层放置。

| 文件 | 最小改动 |
| --- | --- |
| `src/model/team.ts`（新增） | TeamRecord 与 team-ready 的数据类型 |
| `src/storage/team-files.ts`（新增） | team.json 与就绪标记的读写、校验；复用 atomic-json 和原控制锁，不实现调度 |
| `src/services/agents/team-service.ts`（新增） | create/run/pause/close、post/read、关联查询、advance；业务规则集中于此 |
| `src/tools/teams/contract.ts`、`tool.ts`（新增） | 两个工具的 schema、执行适配和结构化结果 |
| `src/extension/teams-command.ts`（新增） | `/pbot teams` 的原生列表、查看和输入；调用同一服务 |
| `src/services/agents/agent-service.ts` | 无任务 start；私人 send 占用检查；窄的 enqueueTeam；空闲无任务退出不伪造失败 |
| `src/storage/agent-files.ts` | enqueue 接受预定 requestId 并去重；必要的锁错误码；旧存储结构不变 |
| `src/extension/subagent-entry.ts` | team-ready、团队领取检查、本地关联、上下文注入与人工插话处理；保留原 pump/finish |
| `src/extension/agent-events.ts` | 在原 refresh 中推进团队；过滤重复个人通知；使用原有通知边界 |
| `src/pbot.ts`、`lifecycle.ts`、工具注册与命令入口 | 装配 TeamFiles/TeamService；关闭前暂停团队；显式注册主/子工具 |
| 现有角色与技能 | 补充公共发言、轮次、独立复核与授权说明，不内置专业流程 |

不改既有 agent 控制类型；0.2.0 只新增原生会话引用类型。保留 PiAgents，不创建 AgentRuntimeService、通用消息总线、调度策略接口或单独 team-events 扫描循环。

TeamService 接收普通成员状态与完成记录，返回待投递的父侧请求；AgentService 负责实际入队和再次校验。AgentService 可读取同一 TeamFiles 检查占用，不反向依赖 TeamService，避免服务循环依赖。Pi ctx 与模型事件仍留在现有接入代码。工具继续绑定工作区实例，关闭后旧调用失效；关停顺序先禁用新增工作并暂停团队，再按原逻辑释放子进程。

`/pbot teams` 首版提供列表、读记录、post、run、pause、close 和进入原成员 TUI。查看不领取模型通知，不抢占现有确认对话框。无 TUI 时使用同样的结构化工具，不另写终端框架。

## 10. 兼容性与验收顺序

### 兼容性

- 0.2.0 不兼容旧会话布局，0.1.x 记录留在原位置，不迁移、不接管或删除；更新后新建 agent。
- 原 descriptor、launch、inbox、status、completions 字段不变；新增会话引用和团队数据放在独立文件中。
- 版本兼容与运行能力分开判断：同一兼容线内还须核对 team-ready，不能只靠版本字符串猜测能力。
- 降级前关闭团队并停止相关进程；不承诺旧子入口能安全参与新团队协议。
- 不自动导入配置，不增加工作区格式、升级系统或存储版本计数。
- 开发依赖现锁定 Pi 1.4.0；测试按新版结构化触发对象调用 before_agent_start，验证用户/custom 消息入口与 turn_end 本地契约，不增加旧 SDK 适配层。

### 三个实现步骤

1. **团队基础**：新增 TeamFiles/TeamService、无任务 start、预定 requestId 入队与 team-ready；验证独立行为和新记录原子性。
2. **最小可用团队**：create/run、轮流讨论、post/read、上下文注入、结果发布和暂停；用原生命令提供入口。
3. **并行与收尾**：增加同一 advance 中的并行轮次分支，补全通知、生命周期和真实多模型验收。

上述团队步骤在 0.1.3 完成。0.2.0 保留执行器与控制字段，另将对话位置交回 Pi，并新增原生会话引用测试。双成员真实模型单轮冒烟针对 0.1.3；新布局的真实模型恢复、多轮/异构模型协作、长时间运行与完整 TUI 验收仍未完成。

### 具体测试风险

使用 node:test、真实本地文件、进程和 Pi SDK；不使用假模型、模拟 provider、个人凭据或真实交易。

- 独立 start/send/read/stop/resume、50 进程限制、原生会话引用与固定叶节点报告；旧布局记录不被迁移或误接管。
- 无任务 start 不发起模型请求，停止待命进程不伪造失败；旧子入口不能误消费新团队请求。
- 同一 requestId 入队不增加两次 sequence；团队关联先于 inbox 发布；真实 I/O 错误不自动重发。
- 团队 run 与私人 send 竞争、两个团队争用同一成员、pause 与领取竞争都有确定结果。
- 轮流顺序、并行上限、轮间汇合、期限、失败暂停，以及运行中 post 不增加模型请求。
- 当前 Pi SDK 的 before_agent_start custom message 与 turn_end 追加顺序；不拆开工具调用和结果，不依赖字符串判别任务。
- Pi 内部多次 agent_start 不丢团队 requestId；人工 mixed 输入不被自动公开。
- 团队 JSON 并发更新不丢消息；长消息分页；结果补交付不重跑、不重复发布。
- 主/子 reload、退出、分支和代次变化后不续排旧批次，主通知不重复、非所属分支不接收结果。

双成员、两种策略各一轮的真实模型冒烟已记录于[验证](validation.md)。剩余真实模型验收包括：A/B/C 在主模型不逐条介入的情况下完成多轮讨论；并行轮次能引用其他成员原文；其他 agent 可同时独立工作；暂停后成员可回到独立工作。连接和测试通过不代表模型理解、业务成功或外部操作恰好一次。

## 11. 源码参考的最小取舍

| 来源 | 本版只采用的部分 |
| --- | --- |
| [YoungJurry/pi-agents](https://github.com/YoungJurry/pi-agents/blob/ec2827cdc0a3bbcdb738fc88d8c277a089af48b7/tools.ts) | 信息与执行请求分开；不引入其 agent 树和统一调度器 |
| [pi-relay](https://github.com/nicknisi/pi-extensions/blob/ef9ab9986584e11541aedd541d0b696e7b83ef8a/packages/relay/index.ts) | 稳定消息身份与“不把发送返回当作处理完成”；不照搬另一套信箱 |
| [pi-messenger-swarm](https://github.com/monotykamary/pi-messenger-swarm/blob/f70a0e6776ce074b23a13778de90614ee9d47b1e/channel.ts) | 公共记录独立于私人会话；不引入服务进程、任务板或事件日志重建 |
| [sloanb/pi-roundtable](https://github.com/sloanb/pi-roundtable/blob/72c4177c241604a2cbb7f2db171be69534d3e20d/lib/roundtable.mjs) | 代码轮流点名、直接提供讨论原文；保留 pbot 持久进程与原生会话 |

这些是源码设计参考，不表示已经安装运行验收。业务授权、工具接入与副作用处理继续遵循[工具与执行](capability-design.md)。团队通信与成员占用规则不是宿主安全隔离。
