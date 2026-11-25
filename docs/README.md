# 文档索引

## 使用

- [项目介绍与安装](../README.zh-CN.md) / [English](../README.md)
- [Antigravity 使用](antigravity.md)：npm 一键安装、原生技能、子代理与跨 Harness 调度
- [Claude Code 使用](claude-code.md)：标准插件安装、原生技能、CLI 与跨 Harness 调度
- [dsh 使用](dsh.md)：profile、插件、Web 管理与聊天命令
- [工作区配置](workspace-configuration.md)：共用启用配置、开放 ACP 目标与配置生效
- [专家协作](agent-collaboration.md)：原生专家、Pi/dsh 团队与跨 Harness ACP 互调
- [历史对话](history.md)：Pi/dsh 查询、摘要与既有归档兼容
- [Python 计算](../resources/references/compute.md)：项目运行与第三方库方法；[指标与回测](../resources/references/compute-finance.md)
- [领域术语](../CONTEXT.md)

## 开发

| 文档 | 内容 |
| --- | --- |
| [架构原则](architecture-guidelines.md) | 两根核心支柱、依赖边界与两类文档方法论 |
| [技术设计](technical-design.md) | 系统组成、生命周期与构建分发 |
| [轻插件宿主与跨 Harness 接入设计](plugin-hosts-design.md) | `PluginHostAdapter`、Claude/Antigravity 插件与薄 stdio MCP/ACP 调度 |
| [模型指令编写原则](model-instruction-guidelines.md) | 运行时模型可见内容（`resources/`）的独立编写方法论 |
| [模型上下文](model-context.md) | 各宿主指令来源、加载时机与更新 |
| [界面设计](interaction-design.md) | 精简 Pi 命令、dsh Web 与 Claude/Antigravity 原生入口 |
| [工具与执行](capability-design.md) | CLI/MCP、开放 ACP 与外部任务 |
| [文件存储](file-storage.md) | 数据位置、写入规则与历史保留 |
| [安装器设计](installation-design.md) | `pbot setup` 的计划、来源、作用域与失败恢复 |
| [npm 发布](release.md) | 候选检查、发布配置与操作 |
| [维护脚本](../scripts/README.md) | 构建、插件校验与安装包检查 |

根目录 README 保留中英文版本，其他主题各维护一份当前说明；测试结果放在任务、PR 或 CI 输出中，历史变更通过 Git 查询。
