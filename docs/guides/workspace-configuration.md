# 工作区配置

所有宿主（Pi、dsh、Claude Code、Antigravity 及其他 MCP 宿主）共用工作区根目录下的 `.pbot/config.json`。宿主原生配置决定插件安装范围，该文件决定 Personal Bot 是否在当前工作区启用，并承载自定义 ACP Harness 启动配置。

## 初始化与状态

| 宿主 | 初始化 | 状态 |
| --- | --- | --- |
| Pi | `/pbot init` | `/pbot status` |
| dsh | `/pbot init` 或 Web 工作区页按钮 | `/pbot status` 或 Web 工作区页 |
| Claude Code | `/personal-bot:pbot init`（或 `lib/claude.js init`） | `/personal-bot:pbot status` |
| Antigravity | `/pbot init`（或 `lib/plugin.js antigravity init`） | `/pbot status` |

`init` 先补建资料目录（`areas/`、`projects/`、`knowledge/`、`providers/`、`scratch/`、`agents/`）和缺失的根 `AGENTS.md`，再将 `.pbot/config.json` 中的 `enabled` 设为 `true`，保留已有资料、宿主自有文件（如 `CLAUDE.md`）及其他未知配置字段；配置文件损坏时先报错而不覆写。

## 启用与停用规则

```json
{
  "enabled": true
}
```

| 配置状态 | 行为 |
| --- | --- |
| `enabled: true` | 启用工作区上下文、技能、Pi/dsh 历史服务与 MCP `pbot_worker` |
| 文件不存在、缺少 `enabled` 或 `enabled: false` | 保持未启用，仅保留状态与初始化入口，宿主原生能力不受影响 |
| JSON 损坏、字段类型错误或不可读 | 保持未启用并报告具体错误，修复后重新启用 |

只检查当前绑定的工作区根目录，不向父目录继承，也不自动迁移历史配置。

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
- 新建 worker 时固定解析后的可执行路径、参数与权限策略；修改 `.pbot/config.json` 后，MCP `pbot_worker` 的下次 `backends` / `models` / `start` 调用自动读取最新 `acp` 配置。

## 手工修改生效方式

| 宿主 | 应用方式 |
| --- | --- |
| Pi | 执行 `/reload` 或重启 Pi |
| dsh | 重启 dsh 服务或桌面应用 |
| Claude Code | 下次 hook 与 CLI/MCP 调用直接读取当前文件 |
| Antigravity | 新会话 `SessionStart`、后续 `PreToolUse` 及 CLI/MCP 调用直接读取当前文件 |
