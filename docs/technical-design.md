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
| src/storage/ | 原子 JSON 与子会话文件 |
| src/extension/ | 命令、事件和资源生命周期 |
| src/ui/ | 确认队列、对话框和专家展示 |
| src/common/ | JSON、校验、文件、包路径和版本辅助逻辑 |
| resources/ | 角色、技能、提示词、模板和参考资料 |

服务不依赖 Pi SDK、工具或 UI。共享进程执行可直接使用，其他宿主能力通过窄接口传入。接入层可引用服务类型；命令和工具通过服务执行状态变更。数据类在进入 JSON、存储和工具结果前转为普通数据。

| 主体 | 管理内容 |
| --- | --- |
| prepareWorkspace | 补建资料目录与根 AGENTS.md |
| PythonEnvironmentService | venv 准备、依赖检查、状态与取消等待 |
| AgentService | 子进程、消息、周期与交付资格 |
| WorkspaceInstance | 工作区资源及环境激活的生命周期 |

## 加载与关闭

Pi 原生配置决定扩展加载范围，启动目录作为工作区根目录。session_start 创建实例、提供工具与技能，并准备共享 Python 环境。加载本身不开展模型任务。

`/pbot init` 可选地补建资料，已有文件保持不变。`/pbot status` 展示路径、版本和 Python 状态；模型通过每轮 pbot_environment 取得工作区、cwd、资源根目录和进程环境信息。

主 reload 保留子进程并重新关联；退出或切换会话时清理子进程、取消环境准备并恢复本实例持有的环境变量。关闭操作幂等。子会话的分支归属、通知和恢复规则见[专家协作](agent-collaboration.md)。

## 资源加载

| 资源 | 用途与加载方式 |
| --- | --- |
| resources/prompts/workspace.md | 主会话与专家的公共约定 |
| resources/agents/、工作区 agents/ | coordinator、general-purpose 及同名工作区补充 |
| resources/skills/ | 通过 resources_discover 提供；专家同时发现工作区技能 |
| resources/references/ | 按需读取的操作参考 |
| resources/templates/workspace-agents.md | 补建根资料入口的模板 |

主会话通过 before_agent_start 增加提示词 section，同时保留 Pi 原生 AGENTS.md 加载。资源在使用时读取，缺失时报错；提示词更新后通过 /reload 或重启加载。

公共约定负责工作区与执行边界，角色负责职责与验收，技能提供专业方法与必要的本地操作约定，工具定义参数与结果语义。工作区资料保存目标、偏好、任务定义和证据，布局见[文件存储](file-storage.md)。

## Python 环境

所有工作区共用当前用户的 venv。PythonEnvironmentService 调用 scripts/setup-python.py，按 python/requirements.lock 创建或对齐依赖，完成 pip check、库导入和基础计算检查后标记就绪。安装仅使用 wheel。

共享锁串行化跨进程 setup，同一服务合并重叠请求。失败或取消时保留环境并报告状态，其他扩展功能继续可用；可通过 `/pbot python setup` 重试。

WorkspaceInstance 在当前进程激活 PATH、VIRTUAL_ENV 和 Python 路径变量，供主会话与专家的 Bash 继承。关闭时恢复仍由本实例持有的变量。环境更新会影响其他工作区，更新前应停止相关脚本。

计算通过原生 Bash 和第三方库 API 执行，使用项目自身的目录、输入和输出约定。路径、安装条件与许可见 [Python 说明](../python/README.md)。

## 工具与分发

工具提供 outputSchema，由 Pi 纳入 pbot namespace；codemode 按工具契约组合调用。原生 CLI/MCP 与可选 Task Conductor 的接入和授权见[工具与执行](capability-design.md)。

包以 TypeScript 源码分发，由 Pi 加载；dist 仅供测试导入。发布版本以 package.json 为准，包内组件共用该版本。子会话兼容线在 1.0 前按次版本、1.0 起按主版本判断，跨线会话不能直接恢复。

开发验证见[验证](validation.md)，分发流程见[npm 发布](release.md)。
