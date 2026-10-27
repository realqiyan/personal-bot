# 文件存储

## 数据位置

| 位置 | 内容与所有者 |
| --- | --- |
| 工作区 AGENTS.md、areas/、projects/、knowledge/ 等 | 用户资料、任务定义与证据 |
| 工作区 providers/<id>/GUIDE.md | 提供方使用说明 |
| 工作区 .pi/settings.json、.pi/mcp.json | Pi 原生项目配置 |
| 当前 Pi agent dir 的 pbot/subagents/ | Personal Bot 子会话记录 |
| 用户级 pbot/python/.venv | 共享 Python 环境 |

Pi 管理主会话与配置。Personal Bot 的工作区资料是普通文件，没有私有启用状态或工作区格式版本。详细目录用途见[项目 README](../README.md#工作区资料)，Python 路径见 [Python 说明](../python/README.md)。

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
| session.jsonl | Pi 原生对话 |

父侧写控制记录，子侧写状态和完成事件，交付收据进入父 Pi 会话。通信顺序与恢复规则见[专家协作](agent-collaboration.md)。

atomic-json 校验完整对象，写入并同步临时文件后原子发布；拒绝目录别名、越界和特殊文件，createOnly 保证不覆盖已有目标。短控制操作使用目录锁。处理崩溃遗留锁前须停止相关 Pi 进程。

## 历史与复制

加载、资料准备和重载保留已有资料、历史记录及备份。扩展只管理自己的子会话与 Python 环境，不自动导入或转换其他应用数据。

复制工作区前停止旧实例。复制资料不会转移用户级会话、运行进程、环境或认证；不支持多机同时写入同步目录。原子文件发布不保证外部操作恰好一次，相关验证范围见[验证](validation.md)。
