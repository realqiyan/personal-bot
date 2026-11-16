---
name: pbot
description: 初始化 Personal Bot 工作区或查看状态。
disable-model-invocation: true
---

# Personal Bot 工作区

从当前 Claude 工作区根目录，通过 Bash 执行对应命令。`${CLAUDE_SKILL_DIR}` 是本技能所在的插件目录。

```sh
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" init
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" status
```

根据用户参数选择一条：`init` 补建资料并启用工作区，`status` 只查看工作区及当前配置状态。省略参数时查看状态。返回命令的实际结果和需要处理的错误。
