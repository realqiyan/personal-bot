---
name: pbot
description: 初始化 Personal Bot 工作区、查看状态、搜索归档或生成历史摘要。
disable-model-invocation: true
---

`--workspace` 传入当前会话的 `workspaceRoot`（工作区未启用时使用当前工作区根目录）。省略子命令时使用 `status`。可执行 `init`、`status`、`history status|list|summary|migrate|search|read`，保留用户指定的维度、模型和筛选参数。

若 `pbot --at-least <release>` 返回 0，运行 `pbot <子命令> --workspace "<workspaceRoot>"`；否则运行 `npx --yes personal-bot@<release> <子命令> --workspace "<workspaceRoot>"`。返回实际结果。
