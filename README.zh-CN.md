# Personal Bot

[English](README.md) | 简体中文

**个人助手，连接知识、研究与行动。**

当前基于 Pi 实现，提供按工作区加载的扩展，用于学习、项目推进、研究与决策支持，也支持投资分析与已授权业务。

定位为可信模型驱动的个人助手。模型负责分析、协调与原生工具使用；pbot 提供资料入口、专家协作和 Python 环境准备。不另建主 Agent，不自动开展任务或交易。

## 安装

需要 Linux、Node.js 22.19+，以及已配置模型和认证的 Pi。Python 计算需要 Python 3.11+。当前开发与测试使用 Pi 1.4.0，其他宿主版本需另行验证。

从目标工作区根目录安装 npm 包并启动：

```bash
pi install --local npm:personal-bot
pi
```

`--local` 将包声明保存在项目 `.pi/settings.json`。按 Pi 提示确认项目信任，每次从工作区根目录启动。Pi 加载 Personal Bot 就会启用角色、技能、工具及共享 Python 环境准备；没有第二个启用开关。不要全局安装，除非希望所有 Pi 会话都启用 Personal Bot。已有全局安装请用 Pi 原生包管理或 `pi config` 调整加载范围。

### 从源码安装

开发时可改用本地源码：

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
cd /path/to/workspace
pi install --local /absolute/path/to/personal-bot
pi
```

将示例路径换成实际路径。本地安装直接加载来源目录，请保留源码和依赖。不要同时加载源码与 npm 两个来源。

### 可选安装 Task Conductor

需要周期任务、重复流程或 DAG 时，安装接入包 `task-conductor-plugin`。它不是服务包 `task-conductor`，也不是启用 pbot 的前提。该接入方式需要 Pi 1.4.0+ 的原生 MCP 和 npm。

先用 `pi list` 检查是否已经安装；已安装但技能不可见时，检查资源是否启用并重载，不要重复安装。新安装请审阅[官方接入说明](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)，从工作区根目录执行：

```bash
pi install --local npm:task-conductor-plugin
```

然后在 Pi 中执行 `/reload`，再调用 `/skill:using-task-conductor`。插件自带技能会在你确认后引导服务安装、`task-conductor setup` 和原生 MCP 接入；插件安装本身不安装服务。凭据留在自己的终端或私有文件中，不发到聊天里。

已有旧版接入包时，先用 `pi list` 核对来源和作用域，审阅官方升级说明后显式移除旧包声明，再安装新包，不同时加载两份。接入包与服务分别更新；服务升级前核对活动任务、停服并备份，按上游说明处理原生 MCP 连接，不自动迁移配置或删除历史数据。

`--local` 只限定插件的加载范围，不隔离服务数据；MCP 注册范围另行选择，保留已有连接，不重复注册。连接完成后用 `/mcp` 或 `pi mcp list` 检查实际工具，并按技能执行只读验证，不为安装验收创建模型任务。连接成功不证明模型认证或业务交付成功。

## 可选资料准备

加载 Personal Bot 后可直接使用，无需初始化。需要标准资料布局时执行 `/pbot init`：只创建缺失的资料目录和根 `AGENTS.md`，不覆盖已有文件，不触发模型任务，也不要求完成确认或重载才能启用。

目标、市场、偏好和工作约定保存在普通资料中，可直接请助手整理。需要接入外部工具时提供 CLI/MCP 名称、用途、官方文档或配置位置，不提供凭据值。

## 日常使用

直接向助手说明任务，例如整理项目资料、比较研究结论、委派独立复核或运行计算。无需手动编排固定流程。

| 命令 | 用途 |
| --- | --- |
| `/pbot init` | 可选地补建资料目录和缺失的根 `AGENTS.md` |
| `/pbot status` | 查看工作区路径、Personal Bot 版本和 Python 环境状态 |
| `/pbot agents` | 查看专家状态；进入会话、补充要求、重命名或停止任务 |
| `/pbot teams` | 查看团队与公共消息，开展轮次、暂停、关闭或进入成员 |
| `/pbot python setup` | 手工重试共享 venv 的准备并激活，无需指定路径 |
| `/reload` | Pi 原生命令，重载插件与资源 |

- **原生工具**：CLI 通过 Bash 使用原生命令与当前 help，手册只保留当前使用所需的信息和证据引用；MCP 默认只接入当前项目，从工作区根目录执行 `pi mcp add --local <server> ...`，保存到 `.pi/mcp.json`，通过 `/mcp` 核对配置来源。只有明确要求跨项目使用时才修改用户级配置。不需要 Personal Bot 注册、参数绑定或权限表。方法见[接入技能](resources/skills/provider-connections/SKILL.md)。
- **研究与分析**：可要求“综合这些资料并说明证据冲突”“核验这份分析的口径与计算”或“找出先要验证的关键假设”。助手按需使用[研究证据技能](resources/skills/research-evidence/SKILL.md)和[分析核验技能](resources/skills/analysis-validation/SKILL.md)，依据本次用途判断结论与限制。
- **独立子会话**：包内提供 tmux 与独立 Pi 会话，需系统安装 tmux。`pbot_agent start` 立即返回；省略 message/prompts/files 时只创建待命进程，不调用模型。工作完成后自动通知。支持模型/目录/文件/工具与资源选项、send、follow-up、rename、status、read、stop 和显式 resume，没有前后台参数或 wait。`/pbot agents` 展示正在工作的 agent，可进入子 TUI。主 reload 保持运行，退出或切换会话停止并保留历史。子会话也使用原生 CLI/MCP，按委派范围工作。详见[专家协作](docs/agent-collaboration.md)。
- **团队协作**：`pbot_team` 将已有 agent 组成固定团队，支持 roundRobin 轮流讨论和 parallel 并行轮次。成员通过 `pbot_team_message` 直接交换原文，普通 post 不唤醒模型。运行中的团队占用成员；先暂停并收尾，再切换私人工作。reload 暂停团队，不重放旧请求。首版不包含动态 ask/返回唤醒，详见[专家协作](docs/agent-collaboration.md)。
- **周期与持久任务**：主会话通过原生 MCP 直接使用可选的 Task Conductor，处理周期、重复流程和 DAG；使用其 `using-task-conductor` 技能与实际工具契约。安装与接入见[可选安装引导](#可选安装-task-conductor)。缺失不影响普通 pbot 功能，但不能执行调度。pbot 不另建持久任务调度器或转发层。外部任务与子会话分别查询和停止，取消本轮不等于停止未来周期，关闭 Pi 也不代表外部任务已停止。
- **Python 环境**：所有工作区共用当前用户的独立 venv。Personal Bot 加载后自动创建环境或安装锁定依赖，成功后在当前 Pi 进程激活；主会话与专家通过 Bash 使用 `python` 或 `python3`。环境异常时提醒，修复后用 `/pbot python setup` 重试。系统 Python、外部终端、已有脚本和历史结果不变。共享依赖更新会影响其他工作区；更换插件版本或手工重试前应停止相关脚本。详见 [Python 说明](python/README.md)与[计算参考](resources/references/compute.md)。
- **资料维护**：可要求“整理当前项目资料”“按上次口径重做报告”或“检查交付并结项”。助手按[项目整理与维护技能](resources/skills/project-maintenance/SKILL.md)更新当前任务及实际受影响的资料；整体整理按用户指定范围进行。当前说明按主题合并更新，保留结论、条件和任务定义；历史证据与重要决策保持可追溯。整理或结项时归集成果并清理范围内无用的临时产物，保留正式资料、历史记录与备份。

主会话和子会话对话都使用 Pi 原生存储。聊天恢复可用 `pi --resume` 明确选择；`pi --continue` 可能选中最近活跃的子会话。受管子会话可从 `/pbot agents` 进入，已停止时加载原会话并待命，不调用模型；`pbot_agent resume` 用于携新要求继续工作。运行中不要另开进程写同一会话文件；不要因恢复而重发可能已产生副作用的操作。

不维护独立 provider 调用账本或结果包装。工具结果及大结果处理由原生工具负责，正式证据按任务保存。结果不明时先查询原生状态；进程崩溃后不保证保存完整结果。

## 工作区资料

| 位置 | 用途 |
| --- | --- |
| `AGENTS.md` | 资料导航与工作约定 |
| `areas/`、`projects/` | 长期目标、任务定义、结论与证据 |
| `knowledge/` | 可复用知识 |
| `providers/` | 提供方手册、覆盖缺口与验证依据 |
| `scratch/` | 临时计算与可重建产物 |
| `agents/`、`.agents/skills/` | coordinator/general-purpose 职责补充与工作区技能 |

Personal Bot 不在工作区内保存私有启用状态。Pi 配置仍由 Pi 管理，配置变更后按原生要求执行 `/reload`。复制工作区前停止旧实例；不支持多机同时写入同步目录。存储布局与复制边界见[文件存储](docs/file-storage.md)。

## 更新与历史数据

当前版本为 **0.2.0**。不维护工作区格式、初始化状态或升级机制。插件更新使用 Pi 原生包管理；本地安装则更新来源源码，依赖变化后执行 `npm ci --ignore-scripts`，再重载或重启 Pi。更换版本前先停止活动子会话；不同兼容线的子会话不能直接恢复。

子会话 JSONL 由 Pi 保存在原生 sessions 目录或原生配置指定的位置；`pbot/subagents/` 只保存控制记录与会话引用，团队公共记录保存在 `pbot/teams/`。0.2.0 不兼容旧会话位置，不迁移或删除 0.1.x 历史；旧记录不进入当前列表或后台调度。先在旧版停止活动成员，更新后重新创建 agent。共享 Python 环境使用用户级 `pbot/python/.venv`，具体系统路径见 [Python 说明](python/README.md)。不自动导入其他应用的会话、配置或环境，也不修改其数据。MCP 连接与 CLI 环境按原生方式显式配置；用户资料、历史证据和备份原样保留。

## 信任与风险

- Personal Bot 不提供逐工具权限或统一审批。CLI、MCP、Bash、Python 和扩展拥有其实际账户与凭据权限，不是沙箱。需要硬限制时使用只读凭据、服务端控制或受限环境。
- 工具可用不等于用户授权。研究、接入与验证不授权交易、转账或账本修改。
- 协议成功不证明业务完成。取消、超时和会话恢复不撤销外部副作用；可能已发送的操作先核对原生状态，不自动重发。
- Task Conductor 节点不自动继承主会话的工具、环境和技能。用户未授权或原生服务要求人工确认的业务，不安排无人值守执行。

完整边界见[原生工具与执行边界](docs/capability-design.md)。真实模型、外部服务和完整 TUI/RPC 交互仍需获准环境验收，本地测试不证明实盘可用。

## 开发与文档

```bash
npm run check
npm test
git diff --check
```

`npm test` 包含冒烟和 E2E 测试，并生成测试用 `dist/`；运行时直接加载源码。包内容可用 `npm pack --dry-run` 检查。测试分组与限制见[验证](docs/validation.md)。

- [开发文档索引](docs/README.md)：架构、工具、专家协作、存储与验证。
- [npm 发布](docs/release.md)：配置、授权、发布与安装验收。
- [领域术语](CONTEXT.md) · [Python 环境、原生库与许可](python/README.md)。
