# 文件存储

## 数据位置

| 位置 | 内容与所有者 |
| --- | --- |
| 工作区 .pbot/config.json | Pi/dsh/Claude 共用的启用与功能配置 |
| 工作区 AGENTS.md、areas/、projects/、knowledge/ 等 | 用户资料、任务定义、方法、结论与交付物 |
| 工作区 providers/<id>/GUIDE.md | 提供方使用说明 |
| 工作区 .pi/settings.json、.pi/mcp.json | Pi 原生项目配置 |
| 工作区 CLAUDE.md、.claude/settings*、.mcp.json | 用户指令与 Claude 原生插件/MCP 配置；pbot init 保留已有内容 |
| Pi 原生 sessions/ 或原生配置指定的目录 | 主会话与子会话的 JSONL 对话，由 Pi 管理 |
| 当前 Pi agent dir 的 pbot/subagents/ | Personal Bot 子进程控制记录与原生会话引用 |
| 当前 Pi agent dir 的 pbot/teams/ | Pi 团队资料、批次与公共原文 |
| dsh 原生会话存储 | dsh 主会话与专家的原生事件，由 dsh 管理 |
| dsh home 的 pbot/subagents/、pbot/teams/ | dsh 专家控制记录、原生 ID 引用与团队公共记录 |
| Claude 原生会话与团队存储 | 主会话、专家与团队均由 Claude 管理，pbot 不解析其私有格式 |
| Claude 配置根已有的 pbot/subagents/、sources/、receipts/、team-sources/ | 旧接入留下的控制记录与引用，保留只读，不由标准插件接管 |
| 工作区 .pbot/history/ | Pi/dsh 问答、摘要与节点关系，以及既有 Claude 归档；Pi/dsh 查询，各写本来源 |

各宿主管理自己的主会话、对话与原生配置。Pi/dsh 的 ACP 成员由所属主会话的控制目录管理，其对端上下文由目标宿主保存和恢复。Claude 标准插件只准备工作区资料，不建立会话控制或历史采集目录。Personal Bot 的工作区资料是普通文件，启用配置集中在 `.pbot/config.json`，不维护工作区格式版本。详细目录用途见[项目 README](../README.zh-CN.md#工作区资料)。

## 资料准备

Pi/dsh 的 `/pbot init` 与 Claude 的原生 `/personal-bot:pbot init` 技能或 Node CLI init 创建缺失的资料目录与根 AGENTS.md。资料目录位置若已被文件占用或是符号链接，则报错；根 AGENTS.md 已存在时直接保留，包括已有符号链接，不跟随链接写入。已创建资料保留，再次执行可继续补缺。

## Pi/dsh 子会话保存

每个 agentId 对应一个目录：

| 文件或记录 | 内容 |
| --- | --- |
| descriptor | 工作区、父 session 与分支锚点 |
| launch | 启动代次、名称、消息序号与停止要求 |
| inbox | 父侧消息 |
| status | 子侧活动与接收标记 |
| completions | 周期结果引用 |
| session-ref.json | Pi 原生会话文件的绝对路径；首次输入前为 null，不保存对话副本 |
| native-session.json | dsh 原生 Session ID；不把 ID 当成 Pi 文件路径 |
| acp-session.json | ACP 目标、固定启动命令与参数、对端会话 ID 和协商能力；pbot agentId 与对端 ID 分开 |
| acp-process.json | ACP worker 的 PID、启动时间和 generation |
| acp-model.json | ACP 的 provider、model、有效 thinking、可选原生 resolvedModel 与所属 generation；独立于最初请求的 options |
| acp-input.json / acp-answer.json | 当前请求关联与 Pi/dsh 成员的最终答复快照 |
| reports/<cycleId>.json | ACP 周期的固定报告，先保存正文，再发布 completion |
| permissions/ | ACP 确认请求与独立答复，绑定成员及 generation |
| team-ready.json | 子入口当前 generation 的团队接入/工具就绪标记，不是存储版本 |

父侧写控制记录，子侧写状态、会话引用和完成事件，交付收据进入所属宿主的父会话；只读页面不写入收据。通信顺序与恢复规则见[专家协作](agent-collaboration.md)。

新 agent 以 agentId 作为原生 session ID，通过 `--session-id` 由 Pi 创建。默认文件位于当前 Pi agent dir 的 `sessions/<Pi 编码的 cwd>/<时间戳>_<sessionId>.jsonl`；遵循子进程的原生环境变量与 settings，不自行编码目录或生成文件名。父会话一次性的 `--session-dir` 参数不会自动传给子进程。

Pi 对没有用户或助手消息的会话延迟落盘。`session-ref.json` 初始为 `{ "file": null }`；子入口在领取请求或接受人工输入前固定 Pi 返回的实际路径，已存在的原生文件在载入时固定引用。固定后不清空、不改指向，恢复时使用该位置。

恢复已绑定会话使用 `--session <绝对路径>`，不根据最近会话或当前目录设置重新选择。文件缺失、非法记录、身份或 cwd 不匹配时拒绝恢复；引用已固定但输入尚未落盘的崩溃窗口也不创建空白替代。只有从未交付输入的待命会话可以重新由 Pi 创建。报告使用 Pi 原生解析器和内存树按固定叶节点只读提取，不写入或迁移 JSONL。

dsh 先 flush 父会话，再创建专家并持久化空会话。公开 Session API 负责存储，pbot 只保存原生 ID。恢复前冷读核对宿主、工作区、父身份、原生身份和占用；清除旧 inbox 后只接纳新代次要求。报告定位到固定 `turn/end` 序号，后续轮次不改变原报告；冷读不启动 Agent。

atomic-json 校验完整对象，写入并同步临时文件后原子发布；拒绝目录别名、越界和特殊文件，createOnly 保证不覆盖已有目标。短控制操作使用目录锁。处理崩溃遗留锁前须停止相关宿主执行实例。

ACP 成员新增独立引用及报告文件，现有 descriptor、launch、inbox、status 和 completions 的持久字段保持不变。cycle.leaf 的 acp 前缀定位固定报告。控制文件不保存凭据或完整原生对话；任务与报告页从 inbox 和周期报告读取，不领取模型通知。Pi/dsh 成员快照只用于精确提取最终答复，ACP 进度文本不直接充当最终报告。

## 既有 Claude 数据

旧接入可能已在 Claude 配置根下留下 `pbot/subagents/`、`pbot/sources/`、`pbot/receipts/` 与 `pbot/team-sources/`。配置根由当时的 `CLAUDE_CONFIG_DIR` 决定，默认 `~/.claude`。这些目录中的 ACP 控制记录、原生来源引用与收据原地保留，标准插件不继续写入、迁移或恢复其中的任务。

工作区已有的 `host: "claude"` 历史归档继续由 Pi/dsh 只读查询。Claude 的原生会话与团队存储仍归宿主管理，标准插件不扫描 transcript、不读取私有团队格式，也不创建新的 pbot 来源、收据或团队目录。

## Pi/dsh 团队保存

每个 teamId 对应 teams/<teamId>/team.json。单文件保存固定成员、批次、请求关联和公共消息；不使用事件日志、快照或迁移计数。每批次保存成员的原有 generation，用于拒绝旧代次请求。

TeamFiles 与 AgentFiles 共用 subagents/.control 短目录锁。读改写在锁内重新读取；不在锁内等待模型、认证或进程退出。post 顺序追加消息，operationId 按入口身份与工具调用 ID 去重；完成答复按 requestId 去重。请求关联先于原 inbox 文件发布，两次保存不冒充跨文件事务。

I/O 失败后当前文件实例停止后续写入，不能因下一次读取成功就重发。恢复时暂停团队；已领取但结果不明的请求保留未知事实，不重跑。仅有领取标记或未完成周期的子 reload 记录为 interrupted，不伪造成功。旧进程确认停止后，resume 在更换 generation 前也封存这些未知请求，避免新状态把它们误当作未领取。已完成但尚未公开的报告可补交付。

关闭团队不删除消息或 agent。既有 descriptor、launch、inbox、status、completions 字段不变；新增引用文件不包含存储版本计数。团队与独立通知分别记录在父原生会话及相应分支；查看公共记录不是模型已读收据。

## 历史索引

工作区 `.pbot/history/` 按 `host` 与原生 `sessionId` 关联会话，使用已有根 `id` 命名文件。

| 相对路径 | 内容 | 写入时机 |
| --- | --- | --- |
| `raw/<id>.json` | 原始问答归档：来源宿主、会话标识与名称、扁平的 `exchanges`，以及由问答 ID 组成的已知原生分支 `branches`。每条问答只含 ID、来源消息 ID、正文、起止时间和完成状态 | 首次纳入旧档，或原生索引发现变化 |
| `summary/<id>.json` | 分层摘要归档：摘要正文、状态、覆盖范围及有序子节点 ID，通过 ID 引用问答或下层摘要 | 承接旧摘要、保存新摘要或使受影响的摘要失效 |

`exchanges` 的排列不代表对话先后。按分支提取时读取 `branches`；只剩旧档时它可为空，逐条提取仍可使用全部问答。`raw/` 不保存派生字段。未命名会话的预览、会话根和反向导航在查询时生成。新提取类型使用与 `raw/` 同级的独立目录，例如未来的 `memory/<id>.json`；当前只写 `raw/` 和 `summary/` 两类归档。

Pi/dsh 分别使用 `.write-pi`、`.write-dsh` 短锁，只拆分和更新本来源；对方仍在旧目录或采用混合格式时照常只读查询。迁移先发布已有摘要，再发布原始问答；两者均已落盘才清理本来源的旧文件。顶层混合归档和先前顶层原文配 `hierarchical/` 的布局均按原 ID 迁移，文件冲突时保留待核对的资料。既有 Claude 混合归档和旧 `.write-claude` 不由标准插件接管。用户操作见[历史对话](history.md)。

## 历史与复制

0.2.0 使用新的子会话兼容线。0.1.x 的控制记录、团队记录和独立目录中的 session.jsonl 原地保留，不导入、不迁移、不自动恢复；当前列表与后台扫描不接管旧兼容线。更新前先用旧版停止活动成员，更新后重新 start。

加载、资料准备和重载保留已有环境、资料、历史记录及备份。Pi/dsh 扩展管理自己的子会话与历史存档，不自动导入或转换其他应用数据。

复制工作区前停止旧实例。包含 `.pbot/history/` 的副本会带上已有各来源的问答与摘要，但不会转移用户级原生会话、运行进程、环境或认证；不支持多机同时写入同步目录。
