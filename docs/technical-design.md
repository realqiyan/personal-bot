# 技术设计

Personal Bot 是按工作区加载的 Pi 扩展。模型负责分析、协调和工具使用；扩展负责资料准备、专家会话和共享 Python 环境。安装与命令见[项目 README](../README.md)。

## 模块与依赖

```text
Pi 命令、工具与事件
         ↓
 tools / extension / ui
         ↓
      services
      ↙      ↘
 storage   窄能力约定
               ↑
          integrations
```

src/pbot.ts 装配依赖并注册入口。

| 目录 | 责任 |
| --- | --- |
| src/tools/ | 输入、输出、schema、执行适配和工具列表 |
| src/services/ | 业务规则、状态变更和操作顺序，按 agents、workspace 聚合 |
| src/model/ | 数据类 |
| src/integrations/ | Pi 会话、Python 环境激活与进程执行 |
| src/storage/ | 原子 JSON、子会话与团队文件 |
| src/extension/ | 命令、事件和资源生命周期 |
| src/ui/ | 确认队列、对话框和专家展示 |
| src/common/ | JSON、校验、文件、包路径和版本辅助逻辑 |
| resources/ | 角色、技能、提示词、模板和参考资料 |

服务不依赖 Pi SDK、工具或 UI。共享进程执行可直接使用，其他宿主能力通过窄接口传入。接入层可引用服务类型；命令和工具通过服务执行状态变更。数据类在进入 JSON、存储和工具结果前转为普通数据。

| 主体 | 管理内容 |
| --- | --- |
| prepareWorkspace | 补建资料目录与根 AGENTS.md |
| PythonEnvironmentService | venv 准备、依赖检查、状态与取消等待 |
| AgentService | 子进程、inbox、周期与交付资格；拒绝向被团队占用的成员发送私人任务 |
| TeamService | 固定成员、公共消息、有限轮次、团队占用与暂停规则 |
| WorkspaceInstance | 工作区资源及环境激活的生命周期 |

## 加载与关闭

Pi 原生配置决定扩展加载范围，启动目录作为工作区根目录。session_start 创建实例、提供工具与技能，并准备共享 Python 环境。加载本身不开展模型任务。

`/pbot init` 可选地补建资料，已有文件保持不变。`/pbot status` 展示路径、版本和 Python 状态；模型通过每轮 pbot_environment 取得工作区、cwd、资源根目录和进程环境信息。

主 reload 保留子进程并重新关联，但暂停团队，不继续安排旧批次；退出或切换会话时清理子进程、取消环境准备并恢复本实例持有的环境变量。关闭操作幂等。子会话的分支归属、通知和恢复规则见[专家协作](agent-collaboration.md)。

## 资源加载

| 资源 | 用途与加载方式 |
| --- | --- |
| resources/prompts/workspace.md | 主会话与专家的公共约定 |
| resources/agents/、工作区 agents/ | coordinator、general-purpose 及同名工作区补充 |
| resources/skills/ | 通过 resources_discover 提供；专家同时发现工作区技能 |
| resources/references/ | 按需读取的操作参考 |
| resources/templates/workspace-agents.md | 补建根资料入口的模板 |

主会话通过 before_agent_start 增加提示词 section，同时保留 Pi 原生 AGENTS.md 加载。资源在使用时读取，缺失时报错；提示词更新后通过 /reload 或重启加载。

公共约定负责工作区与执行边界，角色负责职责与验收，技能提供专业方法与必要的本地操作约定，工具定义参数与结果语义。委派资料修改依据原任务授权及明确的文件责任，诊断环境问题不要求再次授权。工具按 action 校验必填与允许字段，返回具体参数错误；status 不读取报告正文。附件组装由 integrations/pi/agent-input 保留绝对来源及 Pi 原生读取结果。工作区资料保存目标、偏好、任务定义和证据，布局见[文件存储](file-storage.md)。

## 原生子会话存储

PiAgents 使用 `--session-id <agentId>` 启动新的原生会话，让 Pi 按子进程 cwd、环境变量和 settings 决定目录与文件名。AgentFiles 只保存 `session-ref.json`，初始路径为 null。子入口在首次输入前固定实际路径；已落盘会话在载入时绑定。Pi 延迟保存空会话，pbot 不写占位 JSONL 或伪造消息。

菜单进入已停止成员时，AgentService 复用重启校验与代次更新，但不入队输入，子进程保持待命；工具 resume 则明确入队新要求。菜单不再单独提供报告查看或恢复并继续。

恢复使用已绑定的绝对路径，不查找最近会话，也不因配置变化转用其他文件。AgentService 在更换 generation 和入队前要求 Pi 接入层验证文件、session ID 与 cwd。引用绑定后文件不可读取时保守失败，不将未知历史当作空白待命。父侧报告读取使用原生解析器和内存 SessionManager，不改写或迁移原生文件。

会话文件移出控制目录改变恢复契约，因此版本为 0.2.0，旧兼容线不进入当前列表或后台调度；不导入、迁移或删除旧记录。既有控制字段、团队调度及完成叶节点关联保持不变。

## 团队接入

团队采用独立 team.json，不改动旧 AgentMessage、AgentCycle 等持久结构。TeamService 接收普通成员状态与完成记录，安排 roundRobin 或 parallel 轮次；AgentService 再校验并写入原 inbox。父侧原扫描器收集固定叶节点报告并公开原文，不调用主模型转述，不另建执行器或事件总线。

团队关联先保存，再发布输入。跨文件窗口采用保守恢复：不自动重发旧请求，只补交付可核对的完成记录。主/子工具显式注册，子入口只有公共 read/post。Pi 的上下文注入和通知边界分别位于 subagent-entry、agent-events 与 integrations/pi/team-context，服务不持有 Pi ctx。

模型可读的团队任务、背景、公共原文和批次通知使用 Markdown；公共消息 read 复用同一原文渲染。主 agent 收到的独立子会话结果通知，以及 agent/team 工具的列表、状态和报告文本也使用 Markdown。common/markdown 提供字段与原文区块渲染，tools/result 只为这些工具显式选择 Markdown 文本。上下文预算计入实际 Markdown、原文围栏与分页字段。工具 structuredContent、原生 custom message 的去重 details 和控制文件继续使用原有结构化字段，运行时不解析 Markdown 来识别团队或请求。

## Python 环境

所有工作区共用当前用户的 venv。PythonEnvironmentService 调用 scripts/setup-python.py，按 python/requirements.lock 创建或对齐依赖，完成 pip check、库导入和基础计算检查后标记就绪。安装仅使用 wheel。

共享锁串行化跨进程 setup，同一服务合并重叠请求。失败或取消时保留环境并报告状态，其他扩展功能继续可用；可通过 `/pbot python setup` 重试。

WorkspaceInstance 在当前进程激活 PATH、VIRTUAL_ENV 和 Python 路径变量，供主会话与专家的 Bash 继承。关闭时恢复仍由本实例持有的变量。环境更新会影响其他工作区，更新前应停止相关脚本。

计算通过原生 Bash 和第三方库 API 执行，使用项目自身的目录、输入和输出约定。路径、安装条件与许可见 [Python 说明](../python/README.md)。

## 工具与分发

工具提供 outputSchema，由 Pi 纳入 pbot namespace；codemode 按工具契约组合调用。原生 CLI/MCP 与可选 Task Conductor 的接入和授权见[工具与执行](capability-design.md)。

包以 TypeScript 源码分发，由 Pi 加载；dist 仅供测试导入。发布版本以 package.json 为准，包内组件共用该版本。子会话兼容线在 1.0 前按次版本、1.0 起按主版本判断，跨线会话不能直接恢复。

开发验证见[验证](validation.md)，分发流程见[npm 发布](release.md)。
