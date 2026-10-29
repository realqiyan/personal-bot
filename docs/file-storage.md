# 文件存储

## 数据位置

| 位置 | 内容与所有者 |
| --- | --- |
| 工作区 AGENTS.md、areas/、projects/、knowledge/ 等 | 用户资料、任务定义、方法、结论与交付物 |
| 工作区 providers/<id>/GUIDE.md | 提供方使用说明 |
| 工作区 .pi/settings.json、.pi/mcp.json | Pi 原生项目配置 |
| Pi 原生 sessions/ 或原生配置指定的目录 | 主会话与子会话的 JSONL 对话，由 Pi 管理 |
| 当前 Pi agent dir 的 pbot/subagents/ | Personal Bot 子进程控制记录与原生会话引用 |
| 当前 Pi agent dir 的 pbot/teams/ | 团队资料、批次与公共原文 |
| 用户级 pbot/python/.venv | 共享 Python 环境 |

Pi 管理主会话、子会话对话与配置。Personal Bot 的工作区资料是普通文件，没有私有启用状态或工作区格式版本。详细目录用途见[项目 README](../README.md#工作区资料)，Python 路径见 [Python 说明](../python/README.md)。

## 资料准备

`/pbot init` 创建缺失的资料目录与根 AGENTS.md。已有文档保持不变；目录冲突或符号链接时报错，已创建资料保留，再次执行可继续补缺。

## 子会话保存

每个 agentId 对应一个目录：

| 文件或记录 | 内容 |
| --- | --- |
| descriptor | 工作区、父 session 与分支锚点 |
| launch | 启动代次、名称、消息序号与停止要求 |
| inbox | 父侧消息 |
| status | 子侧活动与接收标记 |
| completions | 周期结果引用 |
| session-ref.json | 原生会话文件的绝对路径；首次输入前为 null，不保存对话副本 |
| team-ready.json | 子入口当前 generation 的团队接入/工具就绪标记，不是存储版本 |

父侧写控制记录，子侧写状态、会话引用和完成事件，交付收据进入父 Pi 会话。通信顺序与恢复规则见[专家协作](agent-collaboration.md)。

新 agent 以 agentId 作为原生 session ID，通过 `--session-id` 由 Pi 创建。默认文件位于当前 Pi agent dir 的 `sessions/<Pi 编码的 cwd>/<时间戳>_<sessionId>.jsonl`；遵循子进程的原生环境变量与 settings，不自行编码目录或生成文件名。父会话一次性的 `--session-dir` 参数不会自动传给子进程。

Pi 对没有用户或助手消息的会话延迟落盘。`session-ref.json` 初始为 `{ "file": null }`；子入口在领取请求或接受人工输入前固定 Pi 返回的实际路径，已存在的原生文件在载入时固定引用。固定后不清空、不改指向；它是恢复定位信息，不是输入已落盘、模型已读或执行完成的证明。

恢复已绑定会话使用 `--session <绝对路径>`，不根据最近会话或当前目录设置重新选择。文件缺失、非法记录、身份或 cwd 不匹配时拒绝恢复；引用已固定但输入尚未落盘的崩溃窗口也不创建空白替代。只有从未交付输入的待命会话可以重新由 Pi 创建。报告使用 Pi 原生解析器和内存树按固定叶节点只读提取，不写入或迁移 JSONL。

atomic-json 校验完整对象，写入并同步临时文件后原子发布；拒绝目录别名、越界和特殊文件，createOnly 保证不覆盖已有目标。短控制操作使用目录锁。处理崩溃遗留锁前须停止相关 Pi 进程。

## 团队保存

每个 teamId 对应 teams/<teamId>/team.json。单文件保存固定成员、批次、请求关联和公共消息；不使用事件日志、快照或迁移计数。每批次保存成员的原有 generation，用于拒绝旧代次请求。

TeamFiles 与 AgentFiles 共用 subagents/.control 短目录锁。读改写在锁内重新读取；不在锁内等待模型、认证或进程退出。post 顺序追加消息，operationId 按入口身份与工具调用 ID 去重；完成答复按 requestId 去重。请求关联先于原 inbox 文件发布，两次保存不冒充跨文件事务。

I/O 失败后当前文件实例停止后续写入，不能因下一次读取成功就重发。恢复时暂停团队；已领取但结果不明的请求保留未知事实，不重跑。仅有领取标记或未完成周期的子 reload 记录为 interrupted，不伪造成功。旧进程确认停止后，resume 在更换 generation 前也封存这些未知请求，避免新状态把它们误当作未领取。已完成但尚未公开的报告可补交付。

关闭团队不删除消息或 agent。既有 descriptor、launch、inbox、status、completions 字段不变；新增引用文件不包含存储版本计数。团队与独立通知分别记录在父 Pi 原生分支；查看公共记录不是模型已读收据。

## 历史与复制

0.2.0 使用新的子会话兼容线。0.1.x 的控制记录、团队记录和独立目录中的 session.jsonl 原地保留，不导入、不迁移、不自动恢复；当前列表与后台扫描不接管旧兼容线。更新前先用旧版停止活动成员，更新后重新 start。

加载、资料准备和重载保留已有资料、历史记录及备份。扩展只管理自己的子会话与 Python 环境，不自动导入或转换其他应用数据。

复制工作区前停止旧实例。复制资料不会转移用户级会话、运行进程、环境或认证；不支持多机同时写入同步目录。原子文件发布不保证外部操作恰好一次，相关验证范围见[验证](validation.md)。
