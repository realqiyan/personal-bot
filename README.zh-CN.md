# Personal Bot

[English](README.md) | 简体中文

**连接知识、研究与行动的个人助手。**

Personal Bot 提供按工作区加载的 [Pi](https://pi.dev) 扩展、原生 dsh Web 接入和标准 Claude Code 插件，支持资料整理、项目推进、研究分析、专家协作和已授权的业务操作。Pi/dsh 提供受管专家、团队和历史查询；Claude 使用原生技能、Agent/teams 与 Node command hooks。三个宿主共用工作区资料和专业方法。

Claude 的模型上下文、技能调用与专家行为还需在批准的原生模型环境验证。操作见 [Claude Code 指南](docs/claude-code.md)。

## 工作区启用

安装后，从目标工作区打开宿主。Pi/dsh 执行 `/pbot init`，Claude 使用原生技能 `/personal-bot:pbot init`，初始化资料并启用共用的 `.pbot/config.json`：

```json
{ "enabled": true }
```

配置缺失、停用或无效时，Personal Bot 保持未启用；只检查当前工作区根目录，不自动迁移配置。Pi/dsh 不加载包内技能及 pbot 提示词；Claude 仍可显示静态技能名称和简介，hooks 拦截 Skill 调用和直接斜杠命令中的工作方法并保留 pbot 初始化技能可用。状态入口为 Pi/dsh `/pbot status` 或 Claude `/personal-bot:pbot status`。手工修改后，Pi 执行 `/reload`，dsh 重启宿主；Claude 在 hook 与 CLI 操作时读取当前配置，工作区根由 `CLAUDE_PROJECT_DIR` 固定。规则见[工作区配置](docs/workspace-configuration.md)。

## 安装

### Pi 安装向导

支持 Linux 和 macOS，需要 Node.js 22.19+ 和 npm。在交互终端运行：

```bash
npx personal-bot@latest setup
# 也可直接指定工作区
npx personal-bot@latest setup --workspace ~/pbot-workspace
```

向导选择或创建目录，安装或更新 Pi，再为该工作区安装 Personal Bot。首次默认勾选 Task Conductor 和 Pi Web Access；后续按已有安装预选。普通 npm 来源更新到最新稳定版，本地、Git 和固定版本默认保留，可选择切换。取消勾选会保留已有插件。

缺少 tmux 时使用已有 Homebrew 或受支持的 Linux 包管理器安装。安装完成后可启动 Pi 并执行 `/pbot init`；项目信任、登录和模型选择按 Pi 提示操作。

需要固定短命令时，可全局安装 CLI：

```bash
npm install -g personal-bot@latest
pbot setup
```

此命令副本通过 npm 更新，工作区扩展由 Pi 管理。安装失败后修复原因并重跑，已完成步骤与现有资料保留；可选插件失败时仍可选择进入 Pi。

### 已有 Pi

从工作区根目录执行：

```bash
pi install --local npm:personal-bot
pi
```

`--local` 将安装声明保存在项目 `.pi/settings.json`。启动后在聊天框执行 `/pbot init`。全局安装可让同一份扩展服务多个显式启用的工作区。已有来源通过 `pi list` 或 `pi config` 管理，同一包保留一个有效来源。

### dsh

需要 Node.js 24.9+、npm 和 pnpm；新版本的要求以 dsh `engines` 为准。使用原生 profile 和插件管理器安装：

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# 仅首次创建；该参数会覆盖已有同名 profile
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

在浏览器中选择工作区和主会话，配置模型与认证，执行 `/pbot init` 初始化并启用。聊天输入框的 `/pbot` 打开管理界面，`/pbot status` 查看状态。

以后直接运行 `dsh --profile pbot`。停止活动专家和服务后更新插件：

```bash
dsh plugin --profile pbot update personal-bot --latest
```

桌面应用通过原生“插件”页面安装 `personal-bot@latest`，使用独立的 desktop profile。完整终端参数、更新步骤与聊天命令见 [dsh 指南](docs/dsh.md)。

### Claude Code

使用 Linux 或 macOS 的交互式 Claude Code 终端，需要 **Claude Code 2.1.325+** 和 **Node.js 22.19+**。通过 Claude 原生 marketplace 命令安装：

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

安装范围由 Claude 原生插件管理选择，再在目标工作区使用 `/personal-bot:pbot init` 和 `/personal-bot:pbot status`。它们是原生技能，由模型通过 Bash 执行对应 Node CLI。需要确定性执行时，将 `CLAUDE_PROJECT_DIR` 设为工作区根，直接运行 `node /absolute/path/to/plugin/lib/claude.js init` 或 `node /absolute/path/to/plugin/lib/claude.js status`。登录、模型、权限、原生专家、团队和 MCP 由 Claude 管理；`pbot setup` 仍是 Pi 安装器。

原生团队由用户在启动 Claude 前设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 启用。pbot 不修改该设置，也不在 Claude 中提供 pbot 团队调度。返回会话后明确要求继续工作；原生 resume/rewind 不恢复进程内 teammate。

标准插件提供资料、技能与原生专家，既有 Claude 历史归档和旧控制记录原地保留。操作见 [Claude 指南](docs/claude-code.md)。

### 可选安装 ACP 专家程序

Pi/dsh 使用 ACP 向 Pi、dsh 或 Claude 委派独立工作。先在运行主宿主的机器上安装所需目标：

| 目标 | 安装 | 认证与模型 |
| --- | --- | --- |
| Pi | 已有 Pi 时运行 `npm install -g pi-acp`；Pi 本身可通过 `npm install -g @earendil-works/pi-coding-agent` 安装 | 运行 `pi` 完成登录并选择默认模型 |
| dsh | 已安装命令行 dsh 即可；否则运行 `npm install -g @deepseek-ai/dsh@latest` | 按 dsh 原生方式配置目标 profile 的模型与认证；默认入口为 `dsh --profile acp` |
| Claude Code | `npm install -g @agentclientprotocol/claude-agent-acp` | 按 [Claude Code 指南](https://code.claude.com/docs/en/quickstart)完成登录或 API 配置，并设置默认模型 |

在启动主宿主的同一终端检查目标程序，例如 `command -v claude-agent-acp`。安装后重试原 start 请求。已安装但 PATH 不可见时，将输出的绝对路径写入工作区 [acp 配置](docs/workspace-configuration.md#acp-启动配置)。PATH 变化后重启主宿主；只修改工作区 ACP 配置时，Pi 执行 `/reload`，dsh 重启宿主。

缺少程序时，工具会返回对应安装命令、认证提示和路径配置示例。调用参数与持续对话见[ACP 成员](docs/agent-collaboration.md#acp-成员)。

### 从源码使用

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm run build:cli
node bin/pbot.mjs setup
```

只加载 Pi 源码扩展时，在工作区执行 `pi install --local /absolute/path/to/personal-bot`，并保留该目录和依赖。使用 ACP 成员或 Claude 插件前先运行完整的 `npm run build`。构建顺序是 CLI → dsh → Claude，因为 CLI 构建会清理 `lib/`。dsh 见[源码安装](docs/dsh.md#从源码安装)，Claude 见[开发检查](docs/claude-code.md#依赖与开发检查)。

### 可选安装 Task Conductor

周期任务、重复流程、DAG 和宿主退出后继续执行的任务使用 `task-conductor-plugin`。插件与配套服务分别安装，服务准备和配置遵循[上游接入指南](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。

Pi 用户从工作区运行 `pi install --local npm:task-conductor-plugin`，重载后读取 `/skill:using-task-conductor`。dsh 用户按 [Task Conductor 接入说明](docs/dsh.md#task-conductor)安装，在主会话读取 `/using-task-conductor`。

任务通知回到提交任务的原会话。关闭 Pi 或 dsh 后，服务任务继续运行；当前执行和未来周期分别查询、停止。

## 日常使用

直接说明任务，例如整理资料、比较研究结论、委派复核或运行计算。以下命令面向 Pi；[dsh](docs/dsh.md) 与 [Claude](docs/claude-code.md) 使用各自指南中的原生入口。

| 命令 | 用途 |
| --- | --- |
| `/pbot` | 打开工作区菜单 |
| `/pbot init` | 启用工作区，补建资料目录与缺失的根 `AGENTS.md` |
| `/pbot status` | 查看启用状态、工作区和版本 |
| `/pbot history [关键词]` | 搜索历史问答与摘要，展开原文 |
| `/pbot agents` | 查看、进入、重命名、停止专家，或补充要求 |
| `/pbot teams` | 查看团队与公共消息，开始轮次、暂停或关闭 |
| `/reload` | Pi 原生命令，重载扩展与资源 |

- **初始化与资料准备**：`/pbot init` 补建资料并启用工作区，保留已有资料与其他配置字段。Pi 首次启用时自动重载；已启动时补建的根 AGENTS 经 `/reload` 加载。
- **原生工具**：CLI 通过 Bash 使用，MCP 使用宿主配置。Pi 新增项目连接时执行 `pi mcp add --local <server> ...`，通过 `/mcp` 查看来源。接入方法见[技能](resources/skills/provider-connections/SKILL.md)。
- **历史回溯**：Pi/dsh 刷新和整理自己的来源，查询已有各来源归档，包括保留的 Claude 归档。原文先可查询，主交互结束后用当前模型补齐摘要，会产生额外模型调用；新输入优先取消整理。Claude 使用原生会话历史。详见[历史对话](docs/history.md)。
- **专家与团队**：默认 Pi 专家需要 tmux，dsh 使用原生会话。Pi/dsh 的 pbot 团队可组织轮流讨论与并行轮次，切换私人工作前先暂停并等待在途工作结束；Claude 使用原生 Agent 与团队工具。Pi/dsh 的 ACP 调用 Pi、dsh 和 Claude Code，支持独立对话、报告及显式恢复。ACP 的 model、thinking 均可单独省略，省略项使用目标宿主默认值。详见[专家协作](docs/agent-collaboration.md)。
- **计算**：通过原生 Bash，使用项目声明的解释器、依赖与工作目录。通用方法见 [Python 计算](resources/references/compute.md)，金融计算另见[指标与回测](resources/references/compute-finance.md)。项目所需工具与库在选定环境中安装。
- **资料维护**：可请助手整理项目、按既有口径重做分析或检查交付。按[维护技能](resources/skills/project-maintenance/SKILL.md)更新当前说明、提炼方法，保留正式资料、历史与备份。

Pi 主会话恢复用 `pi --resume` 明确选择；`pi --continue` 可能选中最近活跃的子会话。受管专家从 `/pbot agents` 进入，停止后打开原会话会保持待命，携新要求继续时使用 resume。运行中的会话只保留一个写入进程。

## 工作区资料

| 位置 | 用途 |
| --- | --- |
| `.pbot/config.json` | Pi/dsh/Claude 共用的工作区启用与配置 |
| `AGENTS.md` | 资料导航与工作约定 |
| `areas/`、`projects/` | 长期目标、任务、结论与交付物 |
| `knowledge/` | 可复用的概念、方法与口径 |
| `.pbot/history/` | Pi/dsh 问答原文、摘要与节点关系，以及保留的 Claude 归档 |
| `providers/` | 外部工具的使用说明、数据口径与来源 |
| `scratch/` | 临时脚本、计算数据、下载与运行环境 |
| `agents/` | 职责补充 |
| `.agents/skills/`（Pi/dsh）、`.claude/skills/`（Claude） | 当前宿主原生发现的工作区技能 |

已有布局与工作约定优先。可再次查询的数据在需要时按记录的口径获取。复制工作区前停止旧实例的写入，不支持多机同时写同步目录。详细位置与保留规则见[文件存储](docs/file-storage.md)。

## 更新与操作范围

当前版本为 **0.2.16**。通过宿主原生包管理更新；本地 Pi 来源更新源码，依赖变化后运行 `npm ci --ignore-scripts`，再重载或重启。更换版本前停止活动专家；不同兼容线的专家需重新创建，旧资料、历史和备份保留。

操作按用户请求、已有约定和必要确认执行。Bash、Python、MCP 和扩展使用实际账户与凭据权限；硬限制应由只读凭据、服务端控制或受限环境提供。交易、转账和账本修改需要相应授权。取消、超时或断连后，先查原生状态再决定是否重试，避免重复执行。

Task Conductor 节点单独配置工具、环境、技能与认证；需要人工确认的业务保留人工交互。具体规则见[工具与执行](docs/capability-design.md)。

## 开发与文档

三宿主开发与完整验收使用 Linux、Node.js 24.9+。安装锁定依赖后运行：

```bash
npm run check
npm test
git diff --check
npm pack --dry-run
```

`npm test` 构建测试用 `dist/` 与发布用 `lib/`，运行 Pi/dsh 本地检查与 Claude Node hook 进程测试；Pi 运行时加载源码。Claude 安装包检查实际安装 tarball、执行原生 plugin validate 和 hook/CLI，不调用模型或安装宿主 SDK。真实模型 ACP 与 Claude 上下文、技能、专家验证在明确批准的专用认证环境单独进行。详见[发布说明](docs/release.md)。

- [文档索引](docs/README.md)：当前架构、使用与开发说明。
- [npm 发布](docs/release.md)：候选检查、发布配置与操作。
- [领域术语](CONTEXT.md)。
