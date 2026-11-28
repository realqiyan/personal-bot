# Personal Bot

[English](README.md) | 简体中文

**连接知识、研究与行动的跨 Harness 个人助手层。**

Personal Bot 将 [Pi](https://pi.dev)、DeepSeek Harness（`dsh`）、Claude Code、Antigravity、Codex、Qoder CLI 及任意支持 MCP 的宿主接入同一份工作区——提供共享资料与技能、工作区统一 MCP、跨宿主历史对话，以及基于 ACP v1 的跨 Harness 专家调度。各宿主原生的子代理和团队能力保持独立，互不干扰。

快速导航：[文档总索引](docs/README.md) · [Pi](docs/hosts/pi.md) · [dsh](docs/hosts/dsh.md) · [Claude Code](docs/hosts/claude-code.md) · [Antigravity](docs/hosts/antigravity.md) · [Codex 与 Qoder CLI](docs/hosts/codex-qoder.md)。

## 核心功能

1. **共享工作区与技能**
   - 以统一目录沉淀长期事务、项目产物、可复用知识、外部接入手册、实验脚本与角色约定（`AGENTS.md`、`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/`、`.agents/skills/`）。
   - 通过工作区根目录的 `.pbot/config.json` 显式启用（只检查绑定根目录，不向父目录继承）；配置缺失、停用或损坏时保持休眠。
   - 支持按模块精细开关 `features`（`prompts`、`skills`、`mcp`、`history`，默认均为 `true`），按需启用。

2. **跨 Harness 专家调度（`worker_*`）**
   - 通过单一 stdio MCP 服务（`pbot mcp`）暴露 6 个读写分离的工具：`worker_discover`、`worker_create`、`worker_request`、`worker_response`、`worker_output`、`worker_close`。
   - 内置 `pi`、`dsh`、`claude`、`antigravity`、`codex`、`qoder` 六种 ACP v1 预设，并支持在 `.pbot/config.json` 中接入任意自定义 ACP v1 程序。
   - 与宿主原生子代理互补（Claude `Agent`/团队、Antigravity `invoke_subagent`/`/swarm`、dsh `subagent`），不拦截、不覆盖原生能力。

3. **工作区共享 MCP（`.pbot/mcp.json`）**
   - 通过 `pbot mcp add|list|remove` 在工作区统一维护 stdio 与 Streamable HTTP MCP 服务，支持 `${ENV_VAR}` 环境变量展开，不保存明文凭据。
   - Pi 与 dsh 直接原生挂载；插件宿主通过 `workspace_mcp_discover` / `workspace_mcp_call` 按需调用；ACP worker 自动继承同一组服务。

4. **跨宿主历史对话与摘要（`.pbot/history/`）**
   - 将各已接入宿主的主会话原始问答统一归档到 `.pbot/history/raw/`（默认按年月分层）。
   - 通过 `pbot history summary` 增量生成单会话与月度摘要。
   - 通过 `pbot_history`（Pi / dsh）、MCP `history_search` / `history_read`（插件与其他 MCP 宿主）及 `pbot history` CLI 只读检索与逐层下钻。

### 宿主支持一览

| 宿主 | 接入方式 | 工作区启用 | 跨 Harness MCP | 历史对话 |
| --- | --- | --- | --- | --- |
| **Pi** | 原生扩展 | `/pbot init` | 自动挂载 + `/pbot worker` | `pbot_history` + `/pbot history` |
| **dsh** | 原生插件 + Web 工作台 | `/pbot init` | 自动挂载 + `/pbot worker` | `pbot_history` + Web 历史页 + `/pbot history` |
| **Claude Code** | 原生插件（hooks + MCP） | `/personal-bot:pbot init` | 自动挂载 | Hooks + MCP `history_*` |
| **Antigravity** | 原生插件（hooks + MCP） | `/pbot init` | 自动挂载 | Hooks + MCP `history_*` |
| **Codex** | 原生插件（hooks + MCP） | `pbot plugin codex init` | 自动挂载 | Hooks + MCP `history_*` |
| **Qoder CLI** | 原生插件（hooks + MCP） | `pbot plugin qoder init` | 自动挂载 | Hooks + MCP `history_*` |
| **其他 MCP 宿主**（Cursor 等） | Stdio MCP（`pbot mcp`） | `pbot init` | 手动配置 MCP | MCP `history_*` + CLI |

## 安装

**环境要求**：Linux 或 macOS，Node.js `22.19+` 与 npm（`dsh` 需要 Node.js `24.9+` 与 `pnpm`）。

### 1. 安装通用 CLI（推荐）

```bash
npm install -g personal-bot
```

所有宿主共用 `pbot` CLI（`pbot install`、`pbot init`、`pbot status`、`pbot upgrade`、`pbot mcp`、`pbot history`）。如不想全局安装，可用 `npx personal-bot@latest` 代替 `pbot`。

### 2. 安装宿主插件

**方式一：通过 `pbot install` 统一安装（推荐）**

```bash
# 为本机所有已安装的宿主统一安装（未安装的宿主自动跳过）
pbot install all

# 或为单个宿主安装：pi | dsh | claude | antigravity | codex | qoder
pbot install pi --workspace /path/to/workspace
pbot install claude
```

可通过 `--dsh-profile <名称>` 指定 `dsh` profile（默认 `pbot`）。Codex 安装后需在 `/hooks` 中检查并信任 Personal Bot hooks 再开始会话。

**方式二：各宿主原生安装**

- **Pi**（在目标工作区根目录执行）：`pi install --local npm:personal-bot` · [Pi 使用指南](docs/hosts/pi.md)
- **dsh**（`0.2.2-rc.1+`，Node.js `24.9+`，`pnpm`）：`dsh plugin --profile pbot add personal-bot@latest`（首次创建 profile：`dsh --profile pbot --from-default-profile web --dump-config`） · [dsh 使用指南](docs/hosts/dsh.md)
- **Claude Code**（`2.1.325+`）：`/plugin install personal-bot --marketplace realqiyan/personal-bot` · [Claude Code 使用指南](docs/hosts/claude-code.md)
- **Antigravity**（`agy` `1.5+`）：`agy plugin install "$(npm root -g)/personal-bot/lib/antigravity-plugin"` · [Antigravity 使用指南](docs/hosts/antigravity.md)
- **Codex**：`codex plugin marketplace add "$(npm root -g)/personal-bot/lib/codex-marketplace" && codex plugin add personal-bot@pbot-local`（安装后在 `/hooks` 信任 hooks） · [Codex 与 Qoder CLI 指南](docs/hosts/codex-qoder.md)
- **Qoder CLI**：`qodercli plugin install "$(npm root -g)/personal-bot/lib/qoder-plugin"` · [Codex 与 Qoder CLI 指南](docs/hosts/codex-qoder.md)
- **其他 MCP 宿主（Cursor 等）**：将宿主的 stdio MCP 服务命令配置为 `pbot mcp`（或 `npx personal-bot@latest mcp`）。

## 使用

### 启用工作区

在目标工作区根目录初始化一次即可（所有宿主共用同一份 `.pbot/config.json`）：

```bash
# 在终端执行（适用于所有宿主）
pbot init --workspace /path/to/workspace
```

或在宿主会话中执行对应命令：
- Pi / dsh / Antigravity：`/pbot init`
- Claude Code：`/personal-bot:pbot init`
- Codex / Qoder CLI：`pbot plugin codex init` 或 `pbot plugin qoder init`

`init` 会补建缺失的资料目录与根 `AGENTS.md`（不覆盖已有文件），并启用 `.pbot/config.json`：

```json
{
  "enabled": true,
  "features": {
    "prompts": true,
    "skills": true,
    "mcp": true,
    "history": true
  }
}
```

随时运行 `pbot status`（或会话内 `/pbot status`）查看启用状态与各宿主插件版本同步情况。详见[工作区配置](docs/guides/workspace-configuration.md)。

### 工作区目录说明

| 路径 | 用途 |
| --- | --- |
| `.pbot/config.json` | 工作区启用开关、`features` 模块开关、`acp` 后端与 `history`/`summary` 配置 |
| `.pbot/mcp.json` | 工作区共享的 stdio / HTTP MCP 服务配置 |
| `.pbot/history/` | 各宿主原始问答（`raw/`）与派生摘要（`summaries/`） |
| `AGENTS.md` | 项目索引、工作约定与可选的跨 Harness 分工偏好 |
| `areas/`、`projects/`、`knowledge/` | 长期事务、项目产物与可复用知识方法 |
| `providers/` | 外部 CLI/MCP 使用手册与数据口径 |
| `scratch/` | 临时脚本、计算数据与实验环境 |
| `agents/` | 角色职责补充（`coordinator.md`、`general-purpose.md`） |
| `.agents/skills/` | 跨宿主共享的工作区自有技能（`<name>/SKILL.md`） |

### 常用功能

**1. 跨 Harness 专家调度（`worker_*`）**

在对话中直接要求调用其他宿主（例如“让 Codex 实现并测试模块 A”或“请 Claude 独立审查这份改动”），或在 Pi / dsh 中使用 `/pbot worker` 命令：

```text
/pbot worker overview
/pbot worker backends
/pbot worker models claude
/pbot worker create {"backend":"codex"}
```

使用内置 ACP 目标前，需先安装并登录对应目标程序（`pi-acp`、`dsh`、`@agentclientprotocol/claude-agent-acp`、`agy`、`@agentclientprotocol/codex-acp` 或 `qodercli`）。如需接入自定义 ACP v1 程序，在 `.pbot/config.json` 中声明即可：

```json
{
  "enabled": true,
  "acp": {
    "my-harness": {
      "command": "/absolute/path/to/my-acp",
      "args": ["--stdio"],
      "env": { "MY_HARNESS_MODE": "headless" },
      "permission": "ask"
    }
  }
}
```

详见[跨 Harness 专家调度](docs/guides/cross-harness-workers.md)。

**2. 管理工作区共享 MCP**

```bash
# 添加 stdio MCP 服务
pbot mcp add sqlite --description "本地 SQLite 查询" -- npx -y @modelcontextprotocol/server-sqlite ./data.db

# 添加 Streamable HTTP MCP 服务（用环境变量引用凭据）
pbot mcp add internal-api --url https://mcp.example.com/mcp --header Authorization='Bearer ${INTERNAL_MCP_TOKEN}'

# 查看或移除
pbot mcp list
pbot mcp remove sqlite
```

**3. 跨宿主历史与摘要**

```bash
pbot history status
pbot history summary
pbot history search "评审决定" --limit 10
pbot history read <节点ID>
```

详见[历史对话](docs/guides/history.md)。

## 升级

### 统一升级（推荐）

在工作区根目录执行（或通过 `--workspace <目录>` 指定）：

```bash
pbot upgrade
# 等价别名：pbot update
```

`pbot upgrade` 会将全局 `pbot` CLI 与当前工作区已绑定的各宿主插件统一升级到 npm 最新稳定版，并保留各宿主原有安装作用域。常用选项：

- `--version <x.y.z>`：指定目标版本
- `--hosts <h1,h2>`：仅升级指定宿主（如 `claude,codex`）
- `--dsh-profile <名称>`：自动识别失败时显式指定 dsh profile

同一工作区下多个宿主版本不一致时，`pbot status` 会标记 `outOfSync: true`。

### 单宿主手动升级

- **全局 CLI**：`npm install -g personal-bot@latest`
- **Pi**：`pi install --local npm:personal-bot@latest`（随后在 Pi 中执行 `/reload`）
- **dsh**：先停止运行中的 dsh 服务，再执行 `dsh plugin --profile pbot update personal-bot --latest`
- **Claude Code**：`claude plugin update personal-bot`（重启会话生效）
- **Antigravity**：先执行 `npm install -g personal-bot@latest`，再执行 `agy plugin install "$(npm root -g)/personal-bot/lib/antigravity-plugin"` 或 `pbot install antigravity`（重启会话生效）
- **Codex**：先执行 `npm install -g personal-bot@latest`，再执行 `codex plugin add personal-bot@pbot-local`（若 hooks 有变化，需在 `/hooks` 中重新确认信任）
- **Qoder CLI**：先执行 `npm install -g personal-bot@latest`，再执行 `qodercli plugin install "$(npm root -g)/personal-bot/lib/qoder-plugin"`

## 卸载

### 仅在单个工作区停用

如果只想在某个工作区停用 Personal Bot 而保留插件和资料，将 `.pbot/config.json` 中的 `"enabled"` 改为 `false`（或删除 `.pbot/config.json`）即可。

### 卸载插件与 CLI

按实际安装情况移除对应组件：

- **全局 CLI**：`npm uninstall -g personal-bot`
- **Pi**（在工作区根目录执行）：`pi remove --local npm:personal-bot`
- **dsh**（先停止服务）：`dsh plugin --profile pbot remove personal-bot`
- **Claude Code**：`claude plugin uninstall personal-bot`
- **Antigravity**：`agy plugin uninstall personal-bot`
- **Codex**：`codex plugin remove personal-bot@pbot-local`（可选：`codex plugin marketplace remove pbot-local`）
- **Qoder CLI**：`qodercli plugin uninstall personal-bot`
- **其他 MCP 宿主**：从宿主的 MCP 配置中移除 `pbot` 条目。

### 可选的数据清理

卸载操作不会删除你的工作区资料（`AGENTS.md`、`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/`、`.agents/skills/`）或本地状态。如需彻底清理 Personal Bot 状态文件，可手动删除：

- 工作区状态目录：工作区内的 `.pbot/`（含 `config.json`、`mcp.json` 与 `history/`）
- 用户级缓存与宿主绑定记录：`~/.pbot/`

## 文档与开发

- [文档总索引](docs/README.md) · [工作区配置](docs/guides/workspace-configuration.md) · [跨 Harness 专家调度](docs/guides/cross-harness-workers.md) · [历史对话](docs/guides/history.md) · [工具与执行能力](docs/guides/capabilities.md)
- [架构原则](docs/architecture/principles.md) · [技术设计](docs/architecture/design.md) · [插件与 ACP 扩展设计](docs/architecture/extensibility.md) · [npm 发布与验收](docs/maintainers/release.md) · [领域术语](CONTEXT.md)
- 参与开发与验证请参考 [AGENTS.md](AGENTS.md)。

## 许可证与免责声明

Personal Bot 采用 MIT 许可证。[许可证全文](LICENSE) · [免责声明](DISCLAIMER.md#中文)
