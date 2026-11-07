# 原生 Task Conductor

主会话需要周期、重复流程、DAG 或离开当前宿主会话后继续执行时使用本文。普通独立协助使用 pbot_agent。

## 准备能力

通过当前宿主的原生工具发现查找 Task Conductor，读取 `using-task-conductor` 技能，再按实际 MCP schema 操作。工具未直接显示时，先按技能检查连接；技能缺失时检查插件安装和资源启用状态。

| 宿主 | 插件与技能入口 |
| --- | --- |
| Pi | `pi list` 查看来源与资源；从工作区根目录用 `pi install --local npm:task-conductor-plugin` 安装已发布接入，或用 `pi install --local /absolute/path/to/task-conductor/plugin` 加载未发布源码。当前会话执行 `/reload`，技能入口为 `/skill:using-task-conductor` |
| dsh | 用 `dsh plugin --profile pbot list task-conductor-plugin --depth 0` 查看所选 profile；本地 tarball 使用 `dsh plugin --profile pbot add /absolute/path/to/task-conductor-plugin-<version>.tgz` 安装。重启对应宿主后，通过原生 skill 工具读取 `using-task-conductor`，或在聊天框调用 `/using-task-conductor`。桌面应用使用自己的原生插件页 |

将 `pbot` 和示例路径替换为实际 profile 和产物。dsh 接入包含于尚未发布的 Task Conductor `0.1.6` 候选版本；发布前使用该版本的本地插件及配套服务，构建方法见 [dsh 指南](../../docs/dsh.md#task-conductor)或[上游接入说明](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。宿主聊天命令在相应会话中执行，不能通过 Bash 代执行；已发现技能时直接读取其正文继续。

dsh 插件随包提供共享技能，并为根主会话创建原生 MCP 连接，工作目录取该会话 cwd。通过实际名称调用工具，如 `mcp__task-conductor__executor_list`、`mcp__task-conductor__task_list`；保留名称中的连字符。复用插件连接，已有手工连接按上游方法调整来源，避免重复注册。dsh 接入不需要 Pi 交互 CLI；服务的协调模型单独配置。

服务安装、setup、连接与排障按上游技能处理。dsh 中用 `/task-conductor status` 查看连接状态；服务设置完成或故障修复后用 `/task-conductor connect` 重连。能力不可用时说明具体阻碍，继续不受影响的工作。

## 使用 dsh 执行节点

通过 Task Conductor 管理员 CLI 或 Web 注册自定义执行端 `dsh-acp`，使用 dsh 的规范绝对可执行路径和 `["--profile", "acp"]` 参数；`dsh` 不是内置执行端 ID。注册与查询步骤见上游技能的 `references/custom-acp.md`。在任务节点的 `executorId` 中选择已就绪的 `dsh-acp`。

执行端使用 Task Conductor 后台的运行环境及 dsh 的 `acp` profile，单独准备模型认证、工具、技能和 Python；当前主会话的配置不自动传给节点。

## 定义任务

提交前写明输入、工作目录、所需工具与模型、输出。周期任务还需明确频率、时区、执行范围及每轮数据来源、期间与时点。

准备节点所需的工具、技能、Python 环境和认证。需要人工交互的步骤应留在交互会话中完成。节点直接完成分配的任务，不再递归委派。

## 状态与结果

任务定义、执行和节点分别用 taskId、runId 和节点 ID 标识。提交响应不明时先按已有 ID 查询；未取得 ID 时，按请求关联、任务列表、提交时间或任务特征查找，避免重复创建。实时状态查询 Task Conductor，项目资料保存任务定义、标识和结果位置。

通知回到提交任务的原生持久会话；dsh 恢复原 Session 后可以继续接收待处理事件。同项目的新会话不会代收，仍可通过 MCP 查询任务。

取消当前执行与停止未来周期分别操作，并查询确认。pbot_agent stop 或当前宿主关闭不停止 Task Conductor。报告时区分调度已创建和本轮已完成，并给出对应状态与产物位置。
