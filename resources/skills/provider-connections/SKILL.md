---
name: provider-connections
description: 接入或修复原生 CLI/MCP，核对认证与可用性，维护精简的工作区工具手册。
---

# 原生工具接入

从工作区 `providers/AGENTS.md`、对应 `<id>/GUIDE.md` 和用户给出的资料定位工具，优先复用已有接入。

## CLI

核对已安装版本，通过本次所需子命令的 help 确认参数、默认值和校验。排障时按需查看可信文档或源码。认证复用原生登录与 profile。

## MCP

先核对当前宿主、连接来源与实际配置范围。Pi、dsh 和 Claude 分别管理原生配置，不自动同步模型、认证或 MCP。

### Pi

可先用当前可见工具及 CLI 自主诊断。需要查看当前会话的连接、认证、工具与配置来源时，请用户在该 Pi 会话执行 `/mcp`；这是会话操作，不能通过 Bash 代执行。Bash 中使用 `pi mcp --help` 及相关子命令查询或配置；CLI 查询不等价于当前会话状态，尤其不能据此判断会话内临时连接。

新增连接默认只接入当前项目。从工作区根目录执行 `pi mcp add --local <server> ...`，写入 `.pi/mcp.json`；删除项目连接使用 `pi mcp remove --local <server>`。add/remove 未指定 `--local` 时修改当前 Pi agent dir 的 `mcp.json`，仅在用户明确要求跨项目使用时选择该范围。第三方 setup 同样采用项目配置；无法指定范围时，改用 Pi 原生项目配置。

项目配置经 Pi 项目信任规则加载，同名条目可能覆盖用户级配置。修改前核对同名项，保留无关条目与已有用户级连接；迁移另按用户指定范围处理。认证使用原生登录或环境变量引用。

外部修改配置后，请用户在当前 Pi 会话执行 `/reload`，再用 `/mcp` 查看配置来源和连接状态。当前工具 schema 通过原生工具搜索或 codemode 按需取得。

### dsh

使用当前安装版本的原生 MCP 组件、profile 设置、认证与工具发现。按其公开文档或当前 help 核对参数，不使用 Pi 的命令和 `.pi/mcp.json` 配置方式。同一 profile 的连接可能供多个工作区使用，修改时留意影响范围。

优先复用已有连接，保留无关条目与其他工作区配置。通过原生界面或管理能力修改配置，再从当前会话检查连接和工具；需要用户操作时说明入口。

### Claude Code

通过当前可见工具及 `claude mcp --help`、相关子命令核对已安装版本。当前会话的连接、认证与工具状态在原生 `/mcp` 查看；需要交互登录或刷新时使用该会话入口。Bash 中的 CLI 查询不代表活动会话已重连。

新增连接默认使用项目范围，从工作区根目录执行：

```sh
claude mcp add --scope project --transport http <server> <url>
# stdio 服务
claude mcp add --scope project <server> -- <command> <args...>
```

project 写入工作区 `.mcp.json`，是新增连接的默认范围；明确需要本机私有项目配置时使用 local，用户明确要求跨项目共用时才使用 user。修改前核对同名项和实际来源，保留无关连接。删除时显式指定连接所在范围，例如 `claude mcp remove --scope project <server>`；local 或 user 连接使用对应的 scope，避免 remove 自动选择其他范围。第三方 setup 同样默认采用 project。

认证沿用 Claude 原生 OAuth、登录及环境变量引用，配置中不保存凭据值。修改后按 Claude 提示重连或重启，通过当前会话 `/mcp` 核对来源和工具，再读取实际 schema。

## 检查与手册

用一个简单的只读查询检查所需能力，失败时根据实际错误排障。

`providers/<id>/GUIDE.md` 面向当前使用，保留用途、原生入口、可信资料位置及适用版本。仅补充原生定义未说明、且影响正确使用的口径或限制；工具目录与参数细节从原生 help 和 schema 按需取得。

更新时按主题合并，替换过时说明并同步示例。手册保留当前用法和已知限制，需要详细记录时引用所属项目。

`providers/AGENTS.md` 只做导航和选用约定。
