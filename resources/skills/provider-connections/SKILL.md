---
name: provider-connections
description: 接入或修复工作区共享 MCP 与原生 CLI/MCP，核对认证与可用性，维护精简的工作区工具手册。
---

# 工具与 MCP 接入

先查看工作区 `providers/AGENTS.md`、`providers/<id>/GUIDE.md`、`.pbot/mcp.json` 和当前宿主原生 MCP 列表，优先复用已有接入；同一个 MCP 服务只在一处注册，不同时写入 `.pbot/mcp.json` 与宿主原生配置。

## CLI

确认已安装版本，用本次所需子命令的 `--help` 核对参数、默认值和校验规则，沿用原生登录与 profile。

## MCP 归属判断

接入新 MCP 前先判断归属；边界不明确或用户未说明作用域时，写入前先向用户确认放工作区共享还是当前宿主原生：

- **工作区共享 MCP（`.pbot/mcp.json`）**：归属当前工作区业务、需要跨宿主（Pi、dsh、Claude Code、Antigravity、Codex 及 ACP worker）共用，使用 stdio 或 Streamable HTTP + 环境变量/本地凭据，纯 `tools/list` + `tools/call` 请求-响应且可并发连接的服务。
- **宿主原生 MCP（全局或项目级）**：满足以下任一条件时走当前宿主原生入口，不写入 `.pbot/mcp.json`：
  1. 跨项目通用的本机全局基础设施或开发工具（如浏览器调试、全局调度）；
  2. 依赖宿主浏览器交互式 OAuth 登录；
  3. 依赖宿主配套插件、斜杠命令、原生技能、MCP resources/prompts 或服务端主动事件推送；
  4. 工具极多且高频交互，或独占本机端口/浏览器目录、不宜自动透传给 ACP worker；
  5. 用户明确要求绑定到当前宿主原生配置。

## 工作区共享 MCP（`.pbot/mcp.json`）

不保存明文凭据，使用 `${ENV_VAR}` 引用，保留无关项，不能使用保留名 `pbot`：

- **查看**：`pbot mcp list --workspace <workspaceRoot>` 或（轻插件宿主）调用 `workspace_mcp_discover`
- **新增 / 更新 stdio**：`pbot mcp add <name> --workspace <workspaceRoot> [--env K=\${VAR}] [--cwd .] [--description "..."] -- <command> [args...]`
- **新增 / 更新 HTTP**：`pbot mcp add <name> --workspace <workspaceRoot> --url https://... [--header Authorization="Bearer \${TOKEN}"] [--description "..."]`
- **删除**：`pbot mcp remove <name> --workspace <workspaceRoot>`

生效方式（原生挂载与桥接二选一，不重复暴露）：
- Pi 执行 `/reload`、dsh 重启会话后由宿主直接原生挂载（不暴露 `workspace_mcp_*`）；
- 轻插件宿主与任意 MCP 宿主通过 `workspace_mcp_discover` / `workspace_mcp_call` 桥接，即改即生效，无需重启；
- ACP worker 在下次新建或恢复会话时自动加载最新 `.pbot/mcp.json`。

## 宿主原生 MCP

- **`host = pi`**：项目级用 `pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），全局省略 `--local`；改完后请用户在会话中执行 `/reload` 并用 `/mcp` 检查。
- **`host = dsh`**：通过原生界面或 profile 配置管理（注意同一 profile 可能被多工作区共用）。
- **`host = claude`**：`claude mcp add --scope project --transport http <server> <url>`（写入 `.mcp.json`），改完后请用户在会话中用 `/mcp` 核对认证与工具。
- **`host = antigravity`**：全局使用 `agy mcp add <name> <commandOrUrl> [args...]` / `agy mcp remove <name>`（管理 `~/.gemini/config/mcp_config.json`），通过 `agy mcp list` 或 UI 面板核对。

## 验证与手册

用一个简单的只读查询验证所需能力（例如 `workspace_mcp_discover(server)` + 只读 `workspace_mcp_call` 或原生工具调用），失败时按实际错误排障。

- `providers/<id>/GUIDE.md`：保留用途、接入方式（`.pbot/mcp.json` 或原生入口）、适用版本，以及原生 help/schema 未写明但影响结果的口径和限制；不抄录完整参数表，更新时直接替换过时内容。
- `providers/AGENTS.md`：只做能力导航和选用约定。
