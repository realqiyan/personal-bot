# 工作区配置

所有宿主（Pi、dsh、Claude Code、Antigravity 及其他 MCP 宿主）共用工作区根目录下的 `.pbot/config.json`。宿主原生配置决定插件安装范围，该文件决定 Personal Bot 是否在当前工作区启用，并承载自定义 ACP Harness 启动配置。

## 初始化与状态

| 宿主 | 初始化 | 状态 |
| --- | --- | --- |
| Pi | `/pbot init` | `/pbot status` |
| dsh | `/pbot init` 或 Web 工作区页按钮 | `/pbot status` 或 Web 工作区页 |
| Claude Code | `/personal-bot:pbot init`（或 `lib/claude.js init`） | `/personal-bot:pbot status` |
| Antigravity | `/pbot init`（或 `lib/plugin.js antigravity init`） | `/pbot status` |

`init` 先补建资料目录（`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/`）和缺失的根 `AGENTS.md`，再将 `.pbot/config.json` 中的 `enabled` 设为 `true` 并显式写入 `features`（`prompts`、`skills`、`mcp`、`history`，未设置项默认 `true`），保留已有资料、宿主自有文件（如 `CLAUDE.md`）、已设置的 `features` 开关及其他未知配置字段；配置文件损坏时先报错而不覆写。

## 启用、模块开关（`features`）与停用规则

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

| 配置状态 | 行为 |
| --- | --- |
| `enabled: true` | 启用工作区（`worker_*` 始终可用；`features` 各项省略时默认全部为 `true`） |
| `features.prompts: false` | 关闭工作区提示词与角色上下文注入 |
| `features.skills: false` | 关闭工作区与内置技能注册、技能门控及 `.agents/skills/` 索引注入 |
| `features.mcp: false` | 关闭 `.pbot/mcp.json` 统一 MCP 挂载、`workspace_mcp_*` 桥接与 ACP `mcpServers` 透传 |
| `features.history: false` | 关闭跨宿主历史归档采集、后台摘要整理及历史查询工具（`pbot_history` / `history_search` / `history_read`） |
| 文件不存在、缺少 `enabled` 或 `enabled: false` | 保持未启用，仅保留状态与初始化入口，宿主原生能力不受影响 |
| JSON 损坏、字段类型错误或不可读 | 保持未启用并报告具体错误，修复后重新启用 |

将 `features` 全部设为 `false` 时，可仅使用跨 Harness `worker_*` 调度能力而不注入任何工作区提示词、技能、统一 MCP 或历史功能。只检查当前绑定的工作区根目录，不向父目录继承，也不自动迁移历史配置。

## 统一工作区 MCP 配置（`.pbot/mcp.json`）

在工作区根目录 `.pbot/mcp.json` 中统一注册跨宿主共享的 stdio 或 Streamable HTTP MCP 服务（不保存明文凭据，支持 `${ENV_VAR}` 运行时展开，保留名 `pbot` 不可占用）：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "./data.db"],
      "cwd": ".",
      "description": "本地 SQLite 查询"
    },
    "internal-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${INTERNAL_MCP_TOKEN}" },
      "timeout": 60
    }
  }
}
```

可用 `pbot mcp list|add|remove` 管理该文件。启用 `features.mcp`（默认）后，原生挂载与桥接工具二选一，避免同一服务重复暴露：
- Pi 与 dsh 直接通过原生 API 挂载 `.pbot/mcp.json` 中的服务（不再暴露 `workspace_mcp_*` 桥接工具）；
- 轻插件宿主（Claude Code、Antigravity）及其他 MCP 宿主通过 `pbot` MCP 提供的 `workspace_mcp_discover` / `workspace_mcp_call` 动态发现并调用（修改 `.pbot/mcp.json` 即改即生效）；
- 跨 Harness ACP worker 自动通过 ACP v1 `mcpServers`（或 Pi/dsh 受管成员原生挂载）获得同一组服务。

## ACP Harness 配置（`acp`）

`acp` 字段可覆盖已注册预设目标的命令/权限策略，或直接接入**任意**符合 ACP v1 的自定义 Harness（键名匹配 `^[a-z0-9][a-z0-9-]{0,63}$`），无需改动运行时代码：

```json
{
  "enabled": true,
  "acp": {
    "pi": { "command": "/absolute/path/to/pi-acp", "args": [] },
    "dsh": { "command": "/absolute/path/to/dsh", "args": ["--profile", "acp"] },
    "claude": { "permission": "ask" },
    "antigravity": { "command": "/absolute/path/to/agy", "args": ["acp"] },
    "codex": { "permission": "allow" },
    "my-harness": {
      "command": "/absolute/path/to/my-acp",
      "args": ["--stdio"],
      "env": { "MY_HARNESS_MODE": "headless" },
      "permission": "ask"
    }
  }
}
```

- 自定义目标需提供非空 `command`（以及可选字符串数组 `args`，省略时为 `[]`）；已注册内置目标若只需调整 `env` 或 `permission`，可省略 `command` 和 `args` 以沿用默认启动命令。
- `permission` 可选值为 `"ask"`（默认）、`"allow"`、`"deny"`：未配置或为 `"ask"` 时保持目标 Harness 自身默认权限策略，遇到 `session/request_permission` 时转发给主会话确认；`"allow"` 自动放行；`"deny"` 自动拒绝。
- 命令不经过 shell 展开；参数中的相对路径按 worker 的 `cwd` 解析。凭据与模型认证由目标宿主自行管理，不写入此文件。
- 新建 worker 时固定解析后的可执行路径、参数与权限策略；修改 `.pbot/config.json` 后，MCP 下次 `worker_discover` / `worker_create` 调用自动读取最新 `acp` 配置。

## 手工修改生效方式

| 宿主 | 应用方式 |
| --- | --- |
| Pi | 执行 `/reload` 或重启 Pi |
| dsh | 重启 dsh 服务或桌面应用 |
| Claude Code | 下次 hook 与 CLI/MCP 调用直接读取当前文件 |
| Antigravity | 新会话 `SessionStart`、后续 `PreToolUse` 及 CLI/MCP 调用直接读取当前文件 |
