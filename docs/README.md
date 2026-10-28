# 开发文档

使用与安装见[项目 README](../README.md)。

| 文档 | 内容 |
| --- | --- |
| [架构原则](architecture-guidelines.md) | 模块划分、依赖和开发方法 |
| [技术设计](technical-design.md) | 系统组成、生命周期与资源加载 |
| [工具与执行](capability-design.md) | CLI/MCP 接入、授权和结果核验 |
| [专家协作](agent-collaboration.md) | 子会话工具、通信、通知和生命周期 |
| [文件存储](file-storage.md) | 数据位置、写入规则和历史保留 |
| [验证](validation.md) | 本地测试、真实模型冒烟结果与剩余验收 |
| [npm 发布](release.md) | 发布配置、授权、操作与验收 |

增量设计与范围取舍见 [Subagent 升级方案](subagent-upgrade-proposal.md)。团队策略在 0.1.3 实现，0.2.0 将子会话对话交给 Pi 原生存储，不迁移旧历史。当前用法见专家协作；0.1.3 的真实模型冒烟、0.2.0 本地验证与剩余验收见验证。

Python 环境与库许可见 [python/README.md](../python/README.md)。模型使用的方法维护在 resources/skills，运行时职责维护在 resources/agents。

每个主题维护一份当前说明，总览通过链接引用。版本以 package.json 为准；历史设计查 Git 记录，临时排查过程不进入设计文档。
