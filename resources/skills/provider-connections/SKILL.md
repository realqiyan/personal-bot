---
name: provider-connections
description: 接入或修复工作区共享 MCP 与原生 CLI/MCP，核对认证与可用性，维护精简的工作区工具手册。
---

# 工具与 MCP 接入

先查看工作区 `providers/AGENTS.md`、`providers/<id>/GUIDE.md`、`.pbot/mcp.json` 和用户提供的资料，优先复用已有接入。

## CLI

确认已安装版本，用本次所需子命令的 `--help` 核对参数、默认值和校验规则，沿用原生登录与 profile。

## 工作区共享 MCP（优先）

需要跨宿主（Pi、dsh、Claude Code、Antigravity、Codex 及 ACP worker）共用且使用 stdio 或 Streamable HTTP + 环境变量/本地凭据的 MCP，统一写入工作区 `.pbot/mcp.json`（不保存明文凭据，使用 `${ENV_VAR}` 引用，保留无关项，不能使用保留名 `pbot`）：

- **查看**：`pbot mcp list --workspace <workspaceRoot>` 或调用 `workspace_mcp_discover`
- **新增 / 更新 stdio**：`pbot mcp add <name> --workspace <workspaceRoot> [--env K=\${VAR}] [--cwd .] [--description "..."] -- <command> [args...]`
- **新增 / 更新 HTTP**：`pbot mcp add <name> --workspace <workspaceRoot> --url https://... [--header Authorization="Bearer \${TOKEN}"] [--description "..."]`
- **删除**：`pbot mcp remove <name> --workspace <workspaceRoot>`

生效方式：
- 轻插件宿主与任意 MCP 宿主通过 `workspace_mcp_discover` / `workspace_mcp_call` 即改即生效，无需重启；
- ACP worker 在下次新建或恢复会话时自动加载最新 `.pbot/mcp.json`；
- Pi 执行 `/reload`、dsh 重启会话后同步刷新原生挂载（同时仍可直接用 `workspace_mcp_*`）。

## 宿主原生 MCP（交互式 OAuth 或全局服务）

需要宿主浏览器交互式 OAuth 登录、或用户明确要求绑定到当前宿主全局配置的远程 MCP，仍使用当前宿主的原生入口（可与 `.pbot/mcp.json` 并存，不自动互相同步）：

- **`host = pi`**：`pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），改完后请用户在会话中执行 `/reload` 并用 `/mcp` 检查。
- **`host = dsh`**：通过原生界面或 profile 配置管理（注意同一 profile 可能被多工作区共用）。
- **`host = claude`**：`claude mcp add --scope project --transport http <server> <url>`（写入 `.mcp.json`），改完后请用户在会话中用 `/mcp` 核对认证与工具。
- **`host = antigravity`**：全局使用 `agy mcp add <name> <commandOrUrl> [args...]` / `agy mcp remove <name>`（管理 `~/.gemini/config/mcp_config.json`），通过 `agy mcp list` 或 UI 面板核对。

## 验证与手册

用一个简单的只读查询验证所需能力（例如 `workspace_mcp_discover(server)` + 只读 `workspace_mcp_call` 或原生工具调用），失败时按实际错误排障。

- `providers/<id>/GUIDE.md`：保留用途、接入方式（`.pbot/mcp.json` 或原生入口）、适用版本，以及原生 help/schema 未写明但影响结果的口径和限制；不抄录完整参数表，更新时直接替换过时内容。
- `providers/AGENTS.md`：只做能力导航和选用约定。
