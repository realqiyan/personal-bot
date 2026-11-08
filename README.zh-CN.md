# Personal Bot

[English](README.md) | 简体中文

**连接知识、研究与行动的个人助手。**

Personal Bot 提供按工作区加载的 [Pi](https://pi.dev) 扩展和原生 dsh Web 接入，支持资料整理、项目推进、研究分析、专家协作和已授权的业务操作。模型负责分析与协调，插件提供资料目录、专家会话、历史查询和共享 Python 环境。

## 安装

### Pi 安装向导

支持 Linux 和 macOS，需要 Node.js 22.19+、npm，以及 Python 3.11+ 和 venv/ensurepip。在交互终端运行：

```bash
npx personal-bot@latest setup
# 也可直接指定工作区
npx personal-bot@latest setup --workspace ~/pbot-workspace
```

向导选择或创建目录，安装或更新 Pi，再为该工作区安装 Personal Bot。首次默认勾选 Task Conductor 和 Pi Web Access；后续按已有安装预选。普通 npm 来源更新到最新稳定版，本地、Git 和固定版本默认保留，可选择切换。取消勾选会保留已有插件。

缺少 tmux 时使用已有 Homebrew 或受支持的 Linux 包管理器安装。Python 前置条件缺失时给出修复说明。安装完成后可启动 Pi 并执行 `/pbot init`；项目信任、登录和模型选择按 Pi 提示操作。

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

`--local` 将声明保存在项目 `.pi/settings.json`。每次从工作区根目录启动；加载即启用角色、技能、工具与 Python 环境准备。需要所有 Pi 会话都启用时才使用全局扩展安装。已有来源通过 `pi list` 或 `pi config` 管理，同一包保留一个有效来源。

### dsh

需要 Node.js 24.9+、npm、pnpm 和 Python 3.11+；新版本的要求以 dsh `engines` 为准。使用原生 profile 和插件管理器安装：

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# 仅首次创建；该参数会覆盖已有同名 profile
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

在浏览器中选择工作区和主会话，配置模型与认证。聊天输入框的 `/pbot` 打开管理界面，`/pbot status` 查看状态，`/pbot init` 补建资料。

以后直接运行 `dsh --profile pbot`。停止活动专家和服务后更新插件：

```bash
dsh plugin --profile pbot update personal-bot --latest
```

桌面应用通过原生“插件”页面安装 `personal-bot@latest`，使用独立的 desktop profile。完整终端参数、更新步骤与聊天命令见 [dsh 指南](docs/dsh.md)（[English](docs/dsh.en.md)）。

### 从源码使用

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm run build:cli
node bin/pbot.mjs setup
```

只加载 Pi 源码扩展时，在工作区执行 `pi install --local /absolute/path/to/personal-bot`，并保留该目录和依赖。dsh 的源码打包安装见[专门说明](docs/dsh.md#从源码安装)。

### 可选安装 Task Conductor

周期任务、重复流程、DAG 和宿主退出后继续执行的任务使用 `task-conductor-plugin`。插件与配套服务分别安装，服务准备和配置遵循[上游接入指南](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。

Pi 用户从工作区运行 `pi install --local npm:task-conductor-plugin`，重载后读取 `/skill:using-task-conductor`。dsh 用户按 [Task Conductor 接入说明](docs/dsh.md#task-conductor)安装，在主会话读取 `/using-task-conductor`。

任务通知回到提交任务的原会话。关闭 Pi 或 dsh 后，服务任务继续运行；当前执行和未来周期分别查询、停止。

## 日常使用

直接说明任务，例如整理资料、比较研究结论、委派复核或运行计算。以下命令面向 Pi，dsh 命令见其指南。

| 命令 | 用途 |
| --- | --- |
| `/pbot` | 打开工作区菜单 |
| `/pbot init` | 补建资料目录与缺失的根 `AGENTS.md` |
| `/pbot status` | 查看工作区、版本和 Python 状态 |
| `/pbot history [关键词]` | 搜索历史问答与摘要，展开原文 |
| `/pbot agents` | 查看、进入、重命名、停止专家，或补充要求 |
| `/pbot teams` | 查看团队与公共消息，开始轮次、暂停或关闭 |
| `/pbot python setup` | 重试共享 Python 环境准备 |
| `/reload` | Pi 原生命令，重载扩展与资源 |

- **资料准备**：`/pbot init` 可选，只补建缺失项并保留现有文件。Pi 中新建的根 AGENTS 经 `/reload` 或下次启动后加载。
- **原生工具**：CLI 通过 Bash 使用，MCP 使用宿主配置。Pi 新增项目连接时执行 `pi mcp add --local <server> ...`，通过 `/mcp` 查看来源。接入方法见[技能](resources/skills/provider-connections/SKILL.md)。
- **历史回溯**：Pi 与 dsh 共同查询工作区归档。原文先可查询，主交互结束后用当前模型补齐摘要，会产生额外模型调用；新输入优先取消整理。详见[历史对话](docs/history.md)。
- **专家与团队**：可独立委派、持续对话，或组织轮流讨论和并行轮次。Pi 专家需要 tmux；dsh 使用原生会话。团队运行时占用成员，切换私人工作前先暂停并等待在途工作结束。详见[专家协作](docs/agent-collaboration.md)。
- **Python**：所有工作区共用当前用户的一份 venv，加载时自动准备并在宿主进程激活，通过 Bash 使用 `python` 或 `python3`。更新依赖前停止使用该环境的脚本。路径、排障与许可见 [Python 说明](python/README.md)。
- **资料维护**：可请助手整理项目、按既有口径重做分析或检查交付。按[维护技能](resources/skills/project-maintenance/SKILL.md)更新当前说明、提炼方法，保留正式资料、历史与备份。

Pi 主会话恢复用 `pi --resume` 明确选择；`pi --continue` 可能选中最近活跃的子会话。受管专家从 `/pbot agents` 进入，停止后打开原会话会保持待命，携新要求继续时使用 resume。运行中的会话只保留一个写入进程。

## 工作区资料

| 位置 | 用途 |
| --- | --- |
| `AGENTS.md` | 资料导航与工作约定 |
| `areas/`、`projects/` | 长期目标、任务、结论与交付物 |
| `knowledge/` | 可复用的概念、方法与口径 |
| `.pi/pbot/history/`、`.dsh/pbot/history/` | 问答原文、摘要与节点关系 |
| `providers/` | 外部工具的使用说明、数据口径与来源 |
| `scratch/` | 临时脚本、计算数据、下载与运行环境 |
| `agents/`、`.agents/skills/` | 职责补充与工作区技能 |

已有布局与工作约定优先。可再次查询的数据在需要时按记录的口径获取。复制工作区前停止旧实例的写入，不支持多机同时写同步目录。详细位置与保留规则见[文件存储](docs/file-storage.md)。

## 更新与操作范围

当前版本为 **0.2.9**。通过宿主原生包管理更新；本地 Pi 来源更新源码，依赖变化后运行 `npm ci --ignore-scripts`，再重载或重启。更换版本前停止活动专家；不同兼容线的专家需重新创建，旧资料、历史和备份保留。

操作按用户请求、已有约定和必要确认执行。Bash、Python、MCP 和扩展使用实际账户与凭据权限；硬限制应由只读凭据、服务端控制或受限环境提供。交易、转账和账本修改需要相应授权。取消、超时或断连后，先查原生状态再决定是否重试，避免重复执行。

Task Conductor 节点单独配置工具、环境、技能与认证；需要人工确认的业务保留人工交互。具体规则见[工具与执行](docs/capability-design.md)。

## 开发与文档

双宿主开发使用 Linux、Node.js 24.9+。安装锁定依赖后运行：

```bash
npm run check
npm test
git diff --check
npm pack --dry-run
```

`npm test` 包含冒烟与 E2E 测试，并生成测试用 `dist/` 和发布用 `lib/`。Pi 运行时加载源码。

- [文档索引](docs/README.md)：当前架构、使用与开发说明。
- [npm 发布](docs/release.md)：候选检查、发布配置与操作。
- [领域术语](CONTEXT.md)。
