---
name: pbot
description: 初始化 Personal Bot 工作区、查看状态、搜索归档或生成历史摘要。
disable-model-invocation: true
---

# Personal Bot 工作区

从当前 Claude 工作区根目录，通过 Bash 执行对应命令。`${CLAUDE_SKILL_DIR}` 为本技能目录（位于插件内）。

## 初始化与状态

```sh
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" init
node "${CLAUDE_SKILL_DIR}/../../../../lib/claude.js" status
```

`init` 补建资料目录与根 `AGENTS.md` 并启用工作区，`status` 查看工作区及配置状态；省略参数时执行 `status`。

## 历史管理与检索

`--workspace` 传入当前会话的 `workspaceRoot`（工作区未启用时使用当前工作区根目录）。支持 `history status|list|summary|migrate|search|read`，保留用户指定参数（迁移预览加 `--dry-run`）：

```sh
pbot history summary --workspace "<workspaceRoot>"
```

未安装全局 `pbot` 或版本不匹配时，直接运行随插件打包的 CLI：

```sh
node "${CLAUDE_SKILL_DIR}/../../../../lib/extension/cli.js" history summary --workspace "<workspaceRoot>"
```

返回命令的实际结果和需要处理的错误。
