# 文件存储

## 数据位置

| 位置 | 内容与所有者 |
| --- | --- |
| 工作区 AGENTS.md、areas/、projects/、knowledge/ 等 | 用户资料、任务定义、方法、结论与交付物 |
| 工作区 providers/<id>/GUIDE.md | 提供方使用说明 |
| 工作区 .pi/settings.json、.pi/mcp.json | Pi 原生项目配置 |
| Pi 原生 sessions/ 或原生配置指定的目录 | 主会话与子会话的 JSONL 对话，由 Pi 管理 |
| 当前 Pi agent dir 的 pbot/subagents/ | Personal Bot 子进程控制记录与原生会话引用 |
| 当前 Pi agent dir 的 pbot/teams/ | Pi 团队资料、批次与公共原文 |
| dsh 原生会话存储 | dsh 主会话与专家的原生事件，由 dsh 管理 |
| dsh home 的 pbot/subagents/、pbot/teams/ | dsh 专家控制记录、原生 ID 引用与团队公共记录 |
| 工作区 .pi/pbot/history/、.dsh/pbot/history/ | 按来源保存的问答、摘要、节点关系；双方共同查询 |
| 用户级 pbot/python/.venv | 共享 Python 环境 |

各宿主管理自己的主会话、专家对话与原生配置，不跨宿主恢复或接管。Personal Bot 的工作区资料是普通文件，没有私有启用状态或工作区格式版本。详细目录用途见[项目 README](../README.zh-CN.md#工作区资料)，Python 路径见 [Python 说明](../python/README.md)。

## 资料准备

`/pbot init` 创建缺失的资料目录与根 AGENTS.md。资料目录位置若已被文件占用或是符号链接，则报错；根 AGENTS.md 已存在时直接保留，包括已有符号链接，不跟随链接写入。已创建资料保留，再次执行可继续补缺。

## 子会话保存

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
| team-ready.json | 子入口当前 generation 的团队接入/工具就绪标记，不是存储版本 |

父侧写控制记录，子侧写状态、会话引用和完成事件，交付收据进入所属宿主的父会话；只读页面不写入收据。通信顺序与恢复规则见[专家协作](agent-collaboration.md)。

新 agent 以 agentId 作为原生 session ID，通过 `--session-id` 由 Pi 创建。默认文件位于当前 Pi agent dir 的 `sessions/<Pi 编码的 cwd>/<时间戳>_<sessionId>.jsonl`；遵循子进程的原生环境变量与 settings，不自行编码目录或生成文件名。父会话一次性的 `--session-dir` 参数不会自动传给子进程。

Pi 对没有用户或助手消息的会话延迟落盘。`session-ref.json` 初始为 `{ "file": null }`；子入口在领取请求或接受人工输入前固定 Pi 返回的实际路径，已存在的原生文件在载入时固定引用。固定后不清空、不改指向，恢复时使用该位置。

恢复已绑定会话使用 `--session <绝对路径>`，不根据最近会话或当前目录设置重新选择。文件缺失、非法记录、身份或 cwd 不匹配时拒绝恢复；引用已固定但输入尚未落盘的崩溃窗口也不创建空白替代。只有从未交付输入的待命会话可以重新由 Pi 创建。报告使用 Pi 原生解析器和内存树按固定叶节点只读提取，不写入或迁移 JSONL。

dsh 先 flush 父会话，再创建专家并持久化空会话。公开 Session API 负责存储，pbot 只保存原生 ID。恢复前冷读核对宿主、工作区、父身份、原生身份和占用；清除旧 inbox 后只接纳新代次要求。报告定位到固定 `turn/end` 序号，后续轮次不改变原报告；冷读不启动 Agent。

atomic-json 校验完整对象，写入并同步临时文件后原子发布；拒绝目录别名、越界和特殊文件，createOnly 保证不覆盖已有目标。短控制操作使用目录锁。处理崩溃遗留锁前须停止相关宿主执行实例。

## 团队保存

每个 teamId 对应 teams/<teamId>/team.json。单文件保存固定成员、批次、请求关联和公共消息；不使用事件日志、快照或迁移计数。每批次保存成员的原有 generation，用于拒绝旧代次请求。

TeamFiles 与 AgentFiles 共用 subagents/.control 短目录锁。读改写在锁内重新读取；不在锁内等待模型、认证或进程退出。post 顺序追加消息，operationId 按入口身份与工具调用 ID 去重；完成答复按 requestId 去重。请求关联先于原 inbox 文件发布，两次保存不冒充跨文件事务。

I/O 失败后当前文件实例停止后续写入，不能因下一次读取成功就重发。恢复时暂停团队；已领取但结果不明的请求保留未知事实，不重跑。仅有领取标记或未完成周期的子 reload 记录为 interrupted，不伪造成功。旧进程确认停止后，resume 在更换 generation 前也封存这些未知请求，避免新状态把它们误当作未领取。已完成但尚未公开的报告可补交付。

关闭团队不删除消息或 agent。既有 descriptor、launch、inbox、status、completions 字段不变；新增引用文件不包含存储版本计数。团队与独立通知分别记录在父原生会话及相应分支；查看公共记录不是模型已读收据。

## 历史索引

历史存档按原生 session ID 关联会话，分别保存在工作区 `.pi/pbot/history/` 与 `.dsh/pbot/history/`，各自只写本来源，包含问答文本、来源消息 ID、分支内的四叉摘要与父子关系，复用原子 JSON 写入。来源只记录原生会话 ID 和消息 ID，不保存文件路径；原始会话不可用时仍可查询已存档内容。复制到不同目录或机器后仍可读取，重新发现原生会话时复用原节点。Pi 保留旧归档处理：复制用户级旧目录中当前工作区缺少的记录，旧副本保留，并在已有 Pi 归档中移除旧 file 字段；dsh 不执行该导入或清理。两种来源均保留正文、摘要和节点关系。读取原生文件不迁移或重写历史，不另建工作区格式或版本计数。范围与查询见[历史对话](history.md)。

## 历史与复制

0.2.0 使用新的子会话兼容线。0.1.x 的控制记录、团队记录和独立目录中的 session.jsonl 原地保留，不导入、不迁移、不自动恢复；当前列表与后台扫描不接管旧兼容线。更新前先用旧版停止活动成员，更新后重新 start。

加载、资料准备和重载保留已有资料、历史记录及备份。扩展管理自己的子会话、历史存档与 Python 环境，不自动导入或转换其他应用数据。

复制工作区前停止旧实例。包含两种 history 目录的副本会带上问答与摘要，但不会转移用户级原生会话、运行进程、环境或认证；不支持多机同时写入同步目录。
