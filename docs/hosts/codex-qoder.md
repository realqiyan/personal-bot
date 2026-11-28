# Codex 与 Qoder CLI

两个原生插件共用 npm 包提供的 `pbot` 命令。宿主启动环境的 PATH 需要能找到该命令和 Node.js 22.19+。下面的安装流程适用于 Linux 和 macOS，已用 Codex CLI 0.172.0 和 Qoder CLI 1.1.100 校验。

## 安装

在本仓库使用 Node.js 24.9+ 构建并安装当前工作树的包。

```sh
npm ci --ignore-scripts
npm install --global "$(npm pack --silent | tail -1)"
pbot --version
pbot_lib="$(npm root --global)/personal-bot/lib"
```

按使用的宿主执行对应命令。Codex 通过本地 marketplace 安装。安装后在 Codex 的 `/hooks` 中检查并信任 Personal Bot 的 `SessionStart`、`UserPromptSubmit` 和 `Stop` 命令，再开始会话。更新后若 hook 定义变化，需要重新检查。详见 [Codex 插件 hook 说明](https://developers.openai.com/plugins/build/plugins)。

```sh
codex plugin marketplace add "$pbot_lib/codex-marketplace"
codex plugin add personal-bot@pbot-local
```

Qoder CLI 支持直接从本地插件目录安装。清单和组件目录格式见 [Qoder 插件参考](https://docs.qoder.com/cli/plugins-reference)。

```sh
qodercli plugin install "$pbot_lib/qoder-plugin"
```

## 工作区与工具

在目标工作区根目录执行下列命令，或在宿主中调用插件的 `pbot` 管理技能，传入 `init` 或 `status`。

```sh
pbot plugin codex init
pbot plugin codex status
# Qoder CLI
pbot plugin qoder init
pbot plugin qoder status
```

两个宿主共用一份 `.pbot/config.json`，同一目录初始化一次即可。Codex hook 使用事件的 `cwd`。Qoder 的 hook、管理命令和 MCP 共用 `QODER_PROJECT_DIR`，缺失时依次使用 `PBOT_WORKSPACE_ROOT` 与工作目录。

启用历史后，新会话的 `SessionStart` 会提示旧布局或待更新的摘要。需要处理提醒时，在同一工作区的 Pi 或 dsh 中执行 `/pbot history migrate` 或 `/pbot history summary`。提交提示时按配置注入协调者上下文和包内方法技能索引，`Stop` 配合提交事件记录主会话问答。Codex 按会话和回合 ID 关联追加输入及回复。原始记录的来源分别为 `codex` 和 `qoder`。

宿主原生发现根 `AGENTS.md` 与 `.agents/skills/`。包内方法按 `features.skills` 提供，管理技能可由用户显式调用。

插件的 `.mcp.json` 启动 `pbot mcp`。在启用的工作区可通过 `worker_discover` 查询后端、使用 `worker_create` 指定目标，并通过 `worker_request` 派发任务。调用时使用上下文给出的 `workspaceRoot` 作为 `workspace`。原生子代理由宿主管理。

作为 ACP 目标使用时，`codex` 需要单独安装 `@agentclientprotocol/codex-acp`，`qoder` 使用 `qodercli --acp`（也接受 `qodercli` 和 `qoder-cli` 后端别名）。模型调用沿用目标程序的登录配置。安装原生宿主插件和配置 ACP 后端可以分别进行。

## Codex 转发工作区 MCP 所需的环境变量

如果 `.pbot/mcp.json` 使用 `${INTERNAL_MCP_TOKEN}` 等变量，先在启动 Codex 的环境中设置值，再在 Codex 的用户配置或受信任项目的 `.codex/config.toml` 中按名称转发。以下同名服务配置覆盖插件的默认启动配置。

```toml
[mcp_servers.pbot]
command = "pbot"
args = ["mcp"]
env = { PBOT_HOST = "codex" }
env_vars = ["INTERNAL_MCP_TOKEN"]
```

将示例变量名替换为工作区实际引用的名称，值留在宿主环境中。重启 Codex 后，可用 `codex mcp list --json` 核对 `pbot.transport.env_vars`，并用 `workspace_mcp_discover` 指定服务名验证连接。同一环境也供 ACP worker 解析共享 MCP 配置。详见 [Codex MCP 配置](https://developers.openai.com/codex/mcp)。
