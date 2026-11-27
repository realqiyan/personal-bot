# 历史对话

所有宿主（Pi、dsh、Claude Code、Antigravity 及自定义插件宿主）共用工作区 `.pbot/history/` 归档原始问答：

- **Pi 与 dsh**：提供原生 `pbot_history` 模型工具查询全宿主归档，并在空闲时为所有宿主的原始问答补齐分层摘要；dsh 另提供 Web 工作台“历史”页与 `/pbot history {"action":"search",...}` 命令。
- **Claude Code 与 Antigravity**：通过插件 hook 将主会话原始问答写入 `.pbot/history/raw/`（不调用模型汇总），并通过 `pbot` MCP 提供的只读工具 `history_search` / `history_read` 检索全部宿主的归档与摘要。
- **开关控制**：在 `.pbot/config.json` 中设置 `features.history: false` 可关闭当前工作区的历史采集、摘要整理与查询入口（默认 `true`）。

## 查询契约

| 能力 | 原生 `pbot_history` / MCP 工具 | 可选字段与默认值 |
| --- | --- | --- |
| 搜索 / 列会话 | `action: "search"` / `history_search` | `host`（如 `pi`、`dsh`、`claude`、`antigravity`，省略查全部）、`query`（连续文本，不区分大小写；省略列会话）、`sessionId`、`from`、`to`（含时区 ISO 时间）、`offset=0`、`limit=20`（1–50） |
| 读取节点 | `action: "read"` / `history_read`（必填 `id`） | `host`、`offset=0`、`limit=12000`（1–24000 UTF-16 单元）、`childrenOffset=0`（每页固定 20 个子节点） |

- `nextOffset` / `nextChildrenOffset` 非空时沿原筛选条件续读。跨来源 ID 冲突时显式指定 `host`。
- 所有宿主（Pi、dsh、Claude Code、Antigravity）查询时均只读取工作区 `.pbot/history/` 中的归档，不扫描宿主全局会话目录、不调用模型、不恢复会话。

## 统一事件采集与子会话隔离

- **仅记录主会话原始问答**：所有宿主均在当前主会话的输入与回合结束事件/hook 中通过同一增量入口写入 `.pbot/history/raw/<id>.json`，工具调用、推理和中间过程不写入历史归档。
  - **Pi**：监听主会话 `before_agent_start` 与 `agent_end`；
  - **dsh**：监听根会话 `session/event`（`user/message`、`assistant/message`、`turn/end`）；
  - **Claude Code**：监听 `UserPromptSubmit` 与 `Stop`；
  - **Antigravity**：监听 `Stop`（读取当前会话 `transcriptPath` 提取问答）。
- **天然隔离**：所有受管 ACP worker（带 `PBOT_SUBAGENT_RUN_ID`）、Claude 原生子代理（带 `agent_id`）及 dsh 原生子会话均不触发写入，不会污染工作区历史。

## 分层摘要与存储

- 按分支每四个连续节点形成一层摘要并逐层合并；Pi 与 dsh 在正常主交互结束后的空闲阶段调用当前宿主模型后台补齐（涵盖本宿主与其他宿主的 `raw/` 归档），新人工输入优先取消整理。
- 归档保存在工作区 `.pbot/history/`：`raw/<id>.json` 存原始问答与已知分支（各自只写本宿主来源），`summary/<id>.json` 存派生分层摘要（可失效重建，损坏或缺失不影响原始问答搜索与读取）。
- 备份或迁移工作区前先停止活动写入，再整体复制 `.pbot/history/`。
