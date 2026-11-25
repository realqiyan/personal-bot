# 工作区配置

Pi、dsh 和 Claude Code 共用工作区根目录下的 `.pbot/config.json`。宿主原生配置负责安装和加载插件，此文件决定 Personal Bot 是否在当前工作区启用，也作为后续工作区功能配置的统一入口。

## 初始化与状态

从目标工作区打开宿主，使用相应入口：

| 宿主 | 初始化 | 状态 |
| --- | --- | --- |
| Pi | `/pbot init` | `/pbot status` |
| dsh | `/pbot init` 或工作区页初始化按钮 | `/pbot status` 或工作区页 |
| Claude | 原生技能 `/personal-bot:pbot init` | 原生技能 `/personal-bot:pbot status` |
| Antigravity | 原生技能 `/pbot init` | 原生技能 `/pbot status` |

`init` 先补建资料目录和缺失的根 `AGENTS.md`，再将配置中的 `enabled` 设为 true。已有资料、`CLAUDE.md` 和其他配置字段保留；无效配置在写入前报错。

Pi 首次启用时自动重载；已运行时补建的根 AGENTS 经 `/reload` 加载。dsh 立即启用此目录下已打开的主会话。Claude 的技能由模型通过 Bash 执行同一 Node CLI；确定性执行可直接运行：

```sh
node /absolute/path/to/plugin/lib/claude.js init
node /absolute/path/to/plugin/lib/claude.js status
```

Claude CLI 从 `CLAUDE_PROJECT_DIR` 读取固定工作区根；在普通 shell 中未提供该变量时使用当前目录。需要显式指定工作区时，将它设为目标工作区的绝对路径。状态显示工作区与配置信息；Claude 没有独立的 `/pbot` 原生命令或管理面板。操作见[Claude 使用指南](claude-code.md)。

## 启用与停用

初始化后的配置为：

```json
{
  "enabled": true
}
```

| 配置情况 | 行为 |
| --- | --- |
| `enabled: true` | Pi/dsh 启动业务实例；Claude hooks 加载上下文 |
| 文件不存在、缺少 enabled 或 `enabled: false` | 保持未启用，提供状态与初始化入口；宿主原生功能继续使用 |
| JSON 损坏、字段类型错误或文件不可读取 | 保持未启用，报告具体错误；修复文件后再执行 `init` |

Pi/dsh 未启用时不注册包内技能，也不注入 pbot 提示词。Claude 静态技能名称、简介与原生 agent 仍可被宿主发现；PreToolUse 对 Skill 拦截 pbot 工作方法，保留 `personal-bot:pbot` 初始化技能可用。公共约定与角色加载受配置控制。用户自己的指令、技能与其他插件沿用宿主加载规则；已经进入聊天的内容作为历史保留。

只读取绑定工作区根目录，不向父目录查找。例如在 `~/workspace/projects/example` 单独建立会话时，该目录需要自己的配置。修改 Bash cwd 不改变绑定根目录；Claude 使用 `CLAUDE_PROJECT_DIR` 固定此根。Pi/dsh 受管专家沿用所属工作区的启用决定，其执行目录可以不同。

配置使用普通 JSON，支持可选的布尔值 enabled 和供 Pi/dsh 使用的 ACP 启动配置 acp。其他字段原样保留。此文件是唯一业务启用入口；不自动导入旧配置，不从历史或其他资料推断启用，也不增加工作区格式版本。

## ACP 启动配置

主会话可通过 `pbot_agent`（Pi/dsh 原生工具或 Claude/Antigravity/独立 `pbot mcp` 提供的 MCP 工具）委派不同 ACP Harness。内置目标包括 `pi`（`pi-acp`）、`dsh`（`dsh --profile acp`）、`claude`（`claude-agent-acp`）、`antigravity`（`agy acp`）和 `codex`（`codex-acp`），也可在 `.pbot/config.json` 的 `acp` 字段中覆盖内置命令或新增任意自定义 ACP 名称（小写字母、数字和连字符）：

```json
{
  "enabled": true,
  "acp": {
    "pi": { "command": "/absolute/path/to/pi-acp", "args": [] },
    "dsh": { "command": "/absolute/path/to/dsh", "args": ["--profile", "acp"] },
    "claude": { "command": "/absolute/path/to/claude-agent-acp", "args": [] },
    "antigravity": { "command": "/absolute/path/to/agy", "args": ["acp"] },
    "codex": { "command": "/absolute/path/to/codex-acp", "args": [] },
    "my-harness": { "command": "/absolute/path/to/my-acp", "args": [] }
  }
}
```

每项包含 `command` 和 `args` 字符串数组，只需填写要覆盖或新增的目标。命令不经过 shell 展开，参数中的相对路径按成员 cwd 解析。模型、认证、MCP 和工具由目标宿主管理，凭据值不写入此文件。

创建成员时保存解析后的实际可执行路径和参数。配置生效后的新成员使用新入口；已有成员恢复继续使用保存的入口和会话引用。`acp` 字段无效时，按工作区配置错误处理。成员操作见[专家协作](agent-collaboration.md#acp-成员)。

## 应用手工修改

| 宿主 | 应用方式 |
| --- | --- |
| Pi | 执行原生 `/reload`，或重新启动 Pi |
| dsh | 重启对应服务或桌面宿主 |
| Claude | 后续 UserPromptSubmit、SubagentStart、Skill 调用与技能展开检查及 CLI 操作读取当前配置 |
| Antigravity | 新会话 `SessionStart`、后续 `PreToolUse` 检查及 CLI 操作读取当前配置 |

Pi/dsh 在重载前保持原配置。停用生效后撤下后续业务工具与职责，释放所属执行和历史整理，并暂停团队调度。Claude 停止后续 pbot 上下文注入与工作方法技能调用；原生会话和团队继续由 Claude 管理。资料、历史与备份保留。重新启用可使用各宿主的 init 入口。

## 安装与更新

插件安装和工作区启用分别由宿主插件管理与此配置控制。`pbot setup` 可安装 Pi 并启动 `/pbot init`；Claude 使用原生 marketplace 安装。更新保留现有启用配置、资料与历史，新工作区通过相应 init 入口启用。
