# 历史对话

Pi 与 dsh 提供 `pbot_history` 模型工具查询当前工作区的问答归档；dsh 另提供 Web 工作台“历史”页与 `/pbot history {"action":"search",...}` 命令。Claude Code 与 Antigravity 使用各自宿主的原生会话历史，不写入新的 pbot 历史归档，既有 Claude 归档由 Pi/dsh 保持只读可查。

## 查询契约

| action | 必填字段 | 可选字段与默认值 |
| --- | --- | --- |
| `search` | `action` | `host`（`pi`/`dsh`/`claude`，省略查全部）、`query`（连续文本，不区分大小写；省略列会话）、`sessionId`、`from`、`to`（含时区 ISO 时间）、`offset=0`、`limit=20`（1–50） |
| `read` | `action`, `id` | `host`、`offset=0`、`limit=12000`（1–24000 UTF-16 单元）、`childrenOffset=0`（每页固定 20 个子节点） |

- `nextOffset` / `nextChildrenOffset` 非空时沿原筛选条件续读。跨来源 ID 冲突时显式指定 `host`。
- 查询只刷新当前 Pi/dsh 来源的原生索引并读取其他来源的现成归档，不调用模型、不恢复会话。

## 收录与 ACP 排除

- **原始内容**：仅收录用户输入到有效最终答复的问答单元，工具调用、推理和中间过程留在原生会话记录中。
- **ACP 会话排除**：每次刷新扫描 MCP 控制目录（`~/.pbot/subagents`、`PBOT_MCP_AGENT_DIR`、`PLUGIN_DATA/subagents`）及既有 Pi/dsh 控制目录中的 `acp-session.json`，按 `(backend, sessionId)` 排除 ACP worker 会话，不将其混入主会话历史。
- **既有 Claude 归档**：保留 `host: "claude"` 只读查询，不再扫描 Claude transcript。

## 分层摘要与存储

- 按分支每四个连续节点形成一层摘要并逐层合并；仅在正常主交互结束后的空闲阶段调用当前宿主模型后台补齐，新人工输入优先取消整理。
- 归档保存在工作区 `.pbot/history/`：`raw/<id>.json` 存原始问答与已知分支，`summary/<id>.json` 存派生分层摘要。摘要损坏或缺失不影响原始问答搜索与读取。
- 备份或迁移工作区前先停止活动写入，再整体复制 `.pbot/history/`。
