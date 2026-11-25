---
name: pbot
description: 初始化 Personal Bot 工作区或查看状态。
disable-model-invocation: true
---

# Personal Bot 工作区

从当前 Antigravity 工作区根目录，通过 `run_command` 执行对应命令。`<plugin-root>` 为本 `SKILL.md` 路径向上两级目录（即去掉尾部 `/skills/pbot/SKILL.md` 后的目录）。

```sh
node "<plugin-root>/lib/plugin.js" antigravity init
node "<plugin-root>/lib/plugin.js" antigravity status
```

根据用户参数选择一条：`init` 补建资料目录与根 `AGENTS.md` 并启用工作区，`status` 只查看工作区及当前配置状态。省略参数时查看状态。返回命令的实际结果和需要处理的错误。
