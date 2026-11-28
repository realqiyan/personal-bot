---
name: pbot
description: 初始化 Personal Bot 工作区、查看状态、搜索归档或生成历史摘要。
disable-model-invocation: true
---

# Personal Bot 工作区

从当前 Claude 工作区根目录，通过 Bash 执行对应命令。`${CLAUDE_SKILL_DIR}` 是本技能目录（位于插件内）。

```sh
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" init
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" status
```

根据用户参数选择一条：`init` 补建资料并启用工作区，`status` 只查看工作区及当前配置状态。省略参数时查看状态。返回命令的实际结果和需要处理的错误。

用户要求整理历史时，在当前工作区执行 `pbot history summary --workspace "<workspaceRoot>"`。检查待处理数量用 `history status`，列维度用 `history list`，搜索与读取用 `history search`、`history read`，迁移预览用 `history migrate --dry-run`。保留用户指定的参数。

首次使用或全局 CLI 缺少该子命令时，可直接运行随插件安装的 CLI：

```sh
node "${CLAUDE_SKILL_DIR}/../../../../lib/extension/workspace-cli.js" history summary --workspace "<workspaceRoot>"
```

也可读取 `${CLAUDE_SKILL_DIR}/../../../../package.json` 的 `version`，运行 `npx --yes personal-bot@<version> history summary --workspace "<workspaceRoot>"`。
