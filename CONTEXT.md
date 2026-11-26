# Personal Bot 领域术语

## 资料与接入

**项目**：围绕明确任务保存的目标、资料、结论与交付物。研究项目还包括假设和实验。

**长期事务**：持续维护的目标、约束、决策依据与复盘，可关联多个项目。

**专业方法**：按任务选择的研究、计算、分析或复核方法，包含适用条件与判断依据。

**Personal Bot 宿主**：用户直接与 Personal Bot 主会话交互的 AI 助手环境（如 Pi、dsh、Claude Code、Antigravity 或自定义插件宿主）。

**工作区**：组织资料和开展工作的目录范围。所有宿主共享业务资料与 `.pbot/config.json` 启用配置，各自管理原生会话和运行状态；Pi/dsh 维护工作区历史归档。

**原始问答归档**：Pi/dsh 保存的原始问答与已知原生分支顺序（`.pbot/history/raw/`），不含工具调用、推理与中间过程。

**派生摘要归档**：从原始问答归档生成的分层摘要（`.pbot/history/summary/`），可失效重建，不修改原始问答归档。

**历史消息树（history）**：Pi/dsh 通过 `pbot_history` 查询的原始问答归档、派生摘要归档与父子关系，只读兼容既有 Claude 归档。

**能力提供方（provider）**：通过宿主原生 CLI 或 MCP 提供查询、计算或业务操作的外部系统；代码中的 `src/services/` 则是插件自身的业务服务。

**Personal Bot 启用**：用户通过 `.pbot/config.json` 为当前工作区显式开启 Personal Bot 业务能力。

## 专家与跨 Harness 调度

**协调者（coordinator）**：主会话助手，负责分析、任务组织、按工作区偏好选用宿主原生子代理或跨 Harness worker，并汇总交付。

**宿主原生子代理 / 团队**：由当前宿主原生管理的同宿主子任务与多成员协作（如 Claude `Agent`/团队、Antigravity `invoke_subagent`/`/swarm`、dsh `subagent`）。Personal Bot 不拦截、不覆盖，与跨 Harness 调度互补。

**跨 Harness worker（`worker_*`）**：由统一 stdio MCP 服务（`lib/extension/mcp.js` / `pbot mcp`）经 ACP v1 启动与管理的独立对端 Harness 会话，以 `workerId` 标识，通过 `worker_create` / `worker_close` / `worker_request` / `worker_response` / `worker_output` / `worker_discover` 操作；Pi/dsh 另提供 `/pbot worker` 命令入口。

**工作周期（cycle）**：worker 一次受管工作，以 `cycleId` 标识；结果保存为固定周期报告，通过 `worker_output` 获取与翻页。

**消息请求（request）**：以 `requestId` 标识的一条输入，按接纳、消费和完成记录状态。

**通用专家职责（general-purpose）**：ACP worker 加载的共享独立执行职责（叠加工作区 `agents/general-purpose.md` 补充）。

## 外部任务与操作

**Task Conductor**：通过宿主原生 MCP 使用的独立任务系统，管理周期任务、重复流程、DAG 与持久执行状态。

**用户授权**：用户请求或明确确认的操作范围与条件。硬性权限边界由只读凭据、服务端控制或执行沙箱提供。
