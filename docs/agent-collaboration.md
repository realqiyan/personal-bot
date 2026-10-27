# 专家协作

Personal Bot 通过 tmux 和独立 Pi 进程运行子会话，使用原生 JSONL 上下文和包内子入口。启动立即返回，工作结束后通知主会话。用户通过 /pbot agents 查看活动、进入子 TUI 或停止工作。

## 工具接口

| pbot_agent action | 行为 |
| --- | --- |
| start | 用 message、prompts 或 files 新建上下文，可指定 name/provider/model/thinking/cwd/tools |
| send | 向 agentId 发送 message；delivery 默认为 steer，followUp 排队 |
| rename | 修改名称，agentId 保持不变 |
| status/list | 查询状态或当前父会话的子会话 |
| read | 按 agentId、可选 cycleId 和 offset/limit 读取报告 |
| stop | 请求停止，保留历史 |
| resume | 用新 message 重启已停止子会话 |

每个父会话最多保留 50 个存活进程，包括空闲进程。达到上限后需先停止一个会话。所有启动均异步，不提供 wait。

start 支持 noExtensions、noSkills、noPromptTemplates 和 noContextFiles。noExtensions 默认 true，显式保留子入口及 Pi 内置 MCP、codemode、工具搜索；设为 false 时按 Pi 规则发现其他扩展。子入口不装配递归委派工具，tools 按 Pi 原生规则选择。

## 上下文

初始模型与思考级别默认继承主会话，可显式覆盖；恢复时采用子会话保存的模型配置。认证来自子进程可见的 Pi 配置，父进程临时注册的模型可能不可用。

子入口按原工作区路径加载专家职责、公共约定和技能。pbot_environment 提供工作区、cwd、资源根目录与 Python 状态。子会话不继承完整父聊天，委派应明确目标、依据、约束和交付要求。

默认交回报告与产物引用；修改正式资料需要相应授权。多个助手同时工作时划分文件责任。独立复核使用新会话，而不是继续追问原分析者。

子会话直接使用原生 CLI/MCP，配置与授权规则见[工具与执行](capability-design.md)。基础 write/edit 拒绝需要确认的工作区外写入；其他执行能力仍使用实际账户权限。

## 消息与周期

| 标识 | 含义 |
| --- | --- |
| agentId | 持续上下文 |
| requestId | 父侧发送的消息 |
| cycleId | 一次 agent_start 到 agent_settled 的活动 |

忙碌时补充消息和自动 follow-up 可属于同一周期。消息按序号消费，已接收或代次不匹配的消息不重投；接收标记不等于模型已阅读。

完成根据 agent_settled 与当前周期的新回答判定。失败、取消、无回答和进程死亡分别报告。进程 state/activity 与 cycle.state 分开，idle 只表示当前空闲。历史报告引用固定叶节点，后续对话不覆盖旧报告。

工具返回身份、名称、cwd、时间、owned、进程活动、周期、消息和分页结果。启动代次、分支锚点、报告叶节点和初始选项保存在内部记录。read 的通知领取信息保存在 details。

记录布局与写入责任见[文件存储](file-storage.md)。父侧只有确认旧进程退出后，才可在 resume 前补存旧代次的中断事件。

## 通知与归属

后台扫描状态并合并完成、失败、取消和异常退出通知，交付摘要与报告引用。主模型忙碌时在公开边界交付，空闲时触发处理。人工子 TUI 发起的工作同样标明来源并通知。

通知按 agentId/cycleId 去重。父会话中持久化的通知或有效 read 收据表示领取；UI 查看不领取，运行中 read 不领取未来结果。崩溃可能影响通知交付，但通知重试不重跑任务。

子会话绑定父 session 与创建时的分支锚点。当前分支包含锚点时，主模型才能控制会话或接收结果；其他分支只能看到归属限制，fork 不接管旧子会话。

## UI 与生命周期

主 TUI 展示 starting、busy、stopping 的会话、名称、活动与耗时；空闲会话保留在 /pbot agents 列表。进入子 TUI 不转移控制权，人工输入与父侧消息使用 Pi 队列。

子入口保持同一个会话文件，空闲时可在文件内导航，已完成周期的引用不变。无 UI/RPC 模式通过结构化工具和通知使用子会话，不支持 attach。

| 事件 | 行为 |
| --- | --- |
| 一轮完成 | 保持 idle，可继续对话 |
| 主 reload | 子进程继续，新实例重新关联 |
| 主普通输入、结束本轮、树导航 | 子进程继续；通知检查分支归属 |
| 用户中断 | 暂停主侧自动推进与批准，下一次普通输入恢复 |
| 主退出或切换 session | 请求清理，约 5 秒后终止仍未退出的进程 |
| 恢复主 session | 重建历史和待通知结果，不自动启动工作 |
| stop | 取消并清理子会话工具和连接 |
| resume | 使用新代次和新要求，旧 inbox 与中断工具不重放 |
| 异常崩溃 | 发现死亡进程后标记中断，保留历史 |

停止或恢复不回滚外部副作用。用量与完整过程保存在各自的 Pi 原生会话中。测试和待验收行为见[验证](validation.md)。
