---
name: provider-connections
description: 接入或修复原生 CLI/MCP，核对认证与可用性，维护精简的工作区工具手册。
---

# 原生工具接入

先查看工作区 `providers/AGENTS.md`、`providers/<id>/GUIDE.md` 和用户提供的资料，优先复用已有接入。

## CLI

确认已安装版本，用本次所需子命令的 `--help` 核对参数、默认值和校验规则，沿用原生登录与 profile。

## MCP

按当前环境中的 `host` 使用对应宿主入口；各宿主配置互不同步。新增连接默认限当前项目范围，配置中不保存凭据值（使用原生登录或环境变量引用），修改前核对同名项并保留无关连接。

- **`host = pi`**：项目连接在工作区根目录执行 `pi mcp add --local <server> ...`（写入 `.pi/mcp.json`），删除用 `pi mcp remove --local <server>`；仅用户明确要求跨项目共用时省略 `--local`。改完配置后请用户在当前 Pi 会话执行 `/reload`，再用 `/mcp` 检查连接与认证（`/reload`、`/mcp` 为会话命令，不能通过 Bash 代执行；CLI 查询也不代表当前会话状态）。
- **`host = dsh`**：复用当前 profile 的原生 MCP 组件、认证与工具发现，通过原生界面或管理能力修改配置，不使用 `pi mcp` 或 `.pi/mcp.json`。同一 profile 可能被多个工作区共用，修改前确认影响范围；需要用户操作时说明入口。
- **`host = claude`**：项目连接在工作区根目录执行 `claude mcp add --scope project --transport http <server> <url>` 或 `claude mcp add --scope project <server> -- <command> <args...>`（写入 `.mcp.json`）；本机私有项目配置用 `local`，用户明确要求跨项目共用时才用 `user`。删除时显式指定同 `--scope`。改完后按提示重连或重启，请用户在当前会话用 `/mcp` 核对连接、认证与工具。
- **`host = antigravity`**：项目连接优先写入工作区 `.agents/mcp_config.json`（保留无关连接，不保存凭据值）；全局配置使用原生 `agy mcp add <name> <commandOrUrl> [args...]` 或 `agy mcp remove <name>`（管理 `~/.gemini/config/mcp_config.json`）。改完后通过 `agy mcp list` 或 Antigravity UI 的 MCP 面板核对连接、认证与工具。

## 验证与手册

用一个简单的只读查询验证所需能力，失败时按实际错误排障。

- `providers/<id>/GUIDE.md`：保留用途、原生入口、适用版本，以及原生 help/schema 未写明但影响结果的口径和限制；不抄录完整参数表，更新时直接替换过时内容。
- `providers/AGENTS.md`：只做能力导航和选用约定。
