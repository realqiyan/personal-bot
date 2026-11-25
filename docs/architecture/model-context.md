# 模型上下文

本文说明各宿主主会话与跨 Harness ACP worker 的上下文来源、加载时机与刷新边界。编写规范见[模型指令编写原则](model-instruction-guidelines.md)。

## 共享内容与来源

| 内容 | 来源与加载条件 |
| --- | --- |
| 公共约定与资料目录用途 | `resources/prompts/workspace.md`，已启用主会话与 ACP worker 加载 |
| 协调者 / 通用专家职责 | `resources/agents/coordinator.md`、`general-purpose.md`，叠加工作区 `agents/<role>.md` |
| 协调者操作导航 | Pi/dsh 加载 `resources/prompts/history-coordinator.md`；轻插件宿主加载 `resources/prompts/plugin-coordinator.md` |
| 专业方法技能 | `resources/skills/`（`project-maintenance`、`provider-connections`），只暴露元数据，按任务读取正文 |
| 计算与外部任务参考 | `resources/references/compute.md`、`compute-finance.md`、`task-conductor.md`，按需读取 |
| 历史摘要专用提示 | `resources/prompts/history-summary.md`，仅用于 Pi/dsh 独立历史摘要调用 |

## 各宿主加载方式

| 宿主 | 加载入口 | 根 `AGENTS.md` | 原生 subagent |
| --- | --- | --- | --- |
| **Pi** | `before_agent_start` 刷新 section；`resources_discover` 提供包内技能路径；`registerMcpServer` 挂载 `pbot_worker` | Pi 原生加载与去重 | 不干预 |
| **dsh** | `system-prompt/assemble` 当次刷新 section；技能 provider 仅注册到启用主会话；`dsh-mcp-client` 挂载 `mcp__pbot__pbot_worker` | dsh 原生加载与去重 | 不干预原生 `subagent`/`subagent_fork` |
| **Claude Code** | `UserPromptSubmit` 注入主会话上下文；`PreToolUse(Skill)` / `UserPromptExpansion` 门控未启用技能；`.mcp.json` 挂载 `pbot_worker` | 宿主不自动加载，由 hook 拼装附带 | 含 `agent_id` 的原生子代理直接放行，不注入 |
| **Antigravity** | `SessionStart` 通过 `injectSteps` 一次性注入；`PreToolUse(read_file)` 门控未启用技能；`mcp_config.json` 挂载 `pbot_worker` | Antigravity 原生加载与去重 | 不拦截 `invoke_subagent`，不覆盖 Prompt |

所有宿主在 `PBOT_SUBAGENT_RUN_ID` 存在时（作为 ACP worker 运行）自动跳过主会话上下文注入，避免重复叠加。

## ACP Worker 上下文

- **受管成员（`pi`、`dsh`）**：通过 `pi-acp-member.ts` / `dsh/acp-member.ts` 加载公共约定、`general-purpose` 职责、工作区 `agents/general-purpose.md` 与 `{ host, workspaceRoot, resourceRoot }`，禁止递归调用 `pbot_worker` / `pbot_history`。
- **标准 ACP v1 目标（`claude`、`antigravity`、`codex` 及自定义 Harness）**：由 `acp-worker.ts` 拼装同一上下文；若对端声明 `sessionCapabilities.systemPrompt` 则在建会话时 append，否则在首轮消息前前置一次（后续轮次不重复）。
