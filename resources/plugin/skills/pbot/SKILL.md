---
name: pbot
description: 初始化 Personal Bot 工作区、查看状态、搜索归档或生成历史摘要。
disable-model-invocation: true
---

使用当前会话的 `workspaceRoot` 作为 `--workspace`。省略子命令时使用 `status`。可执行 `init`、`status`、`history status|list|summary|migrate|search|read`。保留用户指定的维度、模型和筛选参数。

运行 `npx --yes personal-bot@<release> <子命令> --workspace "<workspaceRoot>"`。如果 `pbot --at-least <release>` 返回 0，也可以用 `pbot` 执行同一条命令。返回实际结果。
