# 文档索引

Personal Bot 文档按使用场景与职责分为四类，根目录 [README.zh-CN.md](../README.zh-CN.md) / [README.md](../README.md) 提供项目概览与快速安装，[CONTEXT.md](../CONTEXT.md) 定义领域术语。

## 宿主使用指南（`docs/hosts/`）

| 文档 | 适用对象与内容 |
| --- | --- |
| [Pi 使用指南](hosts/pi.md) | `pbot setup` 安装、`/pbot init\|status\|worker`、自动挂载 MCP `worker_*` 与 `pbot_history` |
| [dsh 使用指南](hosts/dsh.md) | profile 与插件管理、工作区/历史 Web 工作台、`/pbot` 聊天命令、自动挂载 MCP `worker_*` |
| [Claude Code 使用指南](hosts/claude-code.md) | 原生插件安装、command hooks、技能门控、MCP `worker_*` 与原生 Agent/团队互补 |
| [Codex 与 Qoder CLI](hosts/codex-qoder.md) | 原生插件安装、工作区启用、hook、历史与 MCP 工具 |
| [Antigravity 使用指南](hosts/antigravity.md) | npm 一键安装、hooks、技能门控、MCP `worker_*` 与原生 `invoke_subagent`/`/swarm` 互补 |

## 通用使用指南（`docs/guides/`）

| 文档 | 内容 |
| --- | --- |
| [工作区配置](guides/workspace-configuration.md) | 共用 `.pbot/config.json` 启用规则、自定义 ACP Harness（含可选 `env`）与配置生效方式 |
| [跨 Harness 专家调度](guides/cross-harness-workers.md) | 统一 MCP `worker_*` 工具集、与宿主原生 subagent 互补边界、ACP 生命周期与交互转发 |
| [历史对话](guides/history.md) | 全宿主统一事件采集、MCP `history_search`/`history_read`、Pi/dsh `pbot_history` 与跨宿主分层摘要 |
| [工具与执行能力](guides/capabilities.md) | 原生 CLI/MCP、Python 计算参考（[通用](../resources/references/compute.md) / [金融](../resources/references/compute-finance.md)）与可选 Task Conductor |

## 架构与扩展设计（`docs/architecture/`）

| 文档 | 内容 |
| --- | --- |
| [架构原则](architecture/principles.md) | 两根核心支柱、统一 MCP 调度、不干扰宿主原生 subagent、可扩展与两类文档方法论 |
| [技术设计](architecture/design.md) | 模块分层与依赖边界、宿主生命周期、文件存储、精简交互界面、安装器与构建分发 |
| [插件宿主与 ACP 扩展设计](architecture/extensibility.md) | 运行时不感知的 `PluginHostRegistry` 与 `AcpHarnessRegistry`、薄 stdio MCP/ACP 桥接与扩展接入步骤 |
| [模型上下文](architecture/model-context.md) | 各宿主与 ACP worker 的指令来源、加载时机与更新规则 |
| [模型指令编写原则](architecture/model-instruction-guidelines.md) | 运行时模型可见资料（`resources/`）的独立编写方法论 |

## 维护与发布（`docs/maintainers/`）

| 文档 | 内容 |
| --- | --- |
| [npm 发布与验收](maintainers/release.md) | 候选包准备、CI/本机发布、消费检查与发布后验收 |
| [维护脚本](../scripts/README.md) | 构建顺序、原生插件校验与消费检查脚本说明 |
