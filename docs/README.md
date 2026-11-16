# 文档索引

## 使用

- [项目介绍与安装](../README.zh-CN.md) / [English](../README.md)
- [dsh 使用](dsh.md)：profile、插件、Web 管理与聊天命令
- [Claude Code 使用](claude-code.md)：标准插件安装、原生技能、CLI 与专家
- [工作区配置](workspace-configuration.md)：三宿主共用启用、静态技能例外与配置生效
- [专家协作](agent-collaboration.md)：原生专家、Pi/dsh 的 pbot 团队、Claude 原生团队与 ACP
- [历史对话](history.md)：Pi/dsh 查询、摘要与既有归档兼容
- [Python 计算](../resources/references/compute.md)：项目运行与第三方库方法；[指标与回测](../resources/references/compute-finance.md)
- [领域术语](../CONTEXT.md)

## 开发

| 文档 | 内容 |
| --- | --- |
| [架构原则](architecture-guidelines.md) | 模块划分、依赖与开发方法 |
| [技术设计](technical-design.md) | 系统组成、生命周期与分发 |
| [Claude Code 接入方案](claude-code-design.md) | 标准 command hooks、原生技能与 agent 边界，以及模型验证范围 |
| [模型指令编写原则](model-instruction-guidelines.md) | 提示、角色、技能与工具说明的取舍 |
| [模型上下文](model-context.md) | 内容来源、加载时机与更新 |
| [界面设计](interaction-design.md) | Pi TUI、dsh GUI 与 Claude 原生入口 |
| [工具与执行](capability-design.md) | CLI/MCP、操作范围与外部任务 |
| [文件存储](file-storage.md) | 数据位置、写入规则与历史保留 |
| [安装器设计](installation-design.md) | setup 的计划、来源、作用域与失败恢复 |
| [npm 发布](release.md) | 候选检查、发布配置与操作 |
| [维护脚本](../scripts/README.md) | 构建与安装包检查 |

根目录 README 保留中英文版本，其他主题各维护一份当前说明。测试结果放在任务、PR 或 CI 输出中，历史方案与变更过程通过 Git 查询。
