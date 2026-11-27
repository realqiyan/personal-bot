# 历史对话

所有宿主（Pi、dsh、Claude Code、Antigravity 及自定义插件宿主）共用工作区 `.pbot/history/` 归档原始问答与多维度摘要：

- **统一 RAW 采集**：各宿主在主会话输入与回合结束时直接写入 `.pbot/history/raw/`（默认按会话开始时间 UTC `YYYY/MM/` 分层），工具调用、推理与子会话均不写入历史。
- **独立 Worker 摘要生成**：通过 Pi / dsh 的 `/pbot history summary` 命令主动扫描 `.pbot/history/raw/`，为每个待摘要项启动**独立的临时 ACP worker**（默认 `backend: "pi"`，使用 Pi 当前默认模型；带 `PBOT_SUBAGENT_RUN_ID` 隔离，绝不写回 `raw/`，不挂载工作区 MCP/技能，跑完即销毁）。可在 `.pbot/config.json` 的 `summary` 字段或命令行参数中切换 `backend`、`model`、`thinking` 与 `concurrency`。
- **独立只读搜索**：Pi 与 dsh 提供原生 `pbot_history` 工具（dsh 另提供 Web 工作台“历史”页与 `/pbot history {"action":...}` 命令）；Claude Code、Antigravity 与其他插件宿主通过 `pbot` MCP 提供的 `history_search` / `history_read` 检索全部宿主的原始问答与各维度摘要。
- **开关控制**：在 `.pbot/config.json` 中设置 `features.history: false` 可关闭当前工作区的历史采集、摘要生成与查询入口（默认 `true`）。
- **启动提醒**：会话启动时自动探测历史目录；当存在未迁移的旧平铺文件（`monthly` 布局下）或原始历史累计满 7 天且近 7 天未更新摘要时，给出一次性轻量提示。

## 命令接口（Pi 与 dsh 对称）

| 命令 | 作用 |
| --- | --- |
| `/pbot history summary [维度...] [--force] [--backend <acp>] [--model <model>] [--thinking <level>]` | 按当前布局扫描历史并执行摘要整理；默认增量去重（未变化跳过、新增对话滚动更新），`--force` 强制全量重刷；`monthly` 布局下自动依次生成 `session` 与 `monthly` 汇总 |
| `/pbot history migrate [--dry-run]` | 显式将旧平铺 `.pbot/history/raw/*.json` 与 `summaries/<dimension>/*.json` 按 UTC 开始时间直接移动至 `YYYY/MM/`（或 `unknown/`），不保留副本、不修改配置文件、不覆盖目标冲突文件 |
| `/pbot history status` | 查看当前历史布局、原始会话数、各维度已就绪 / 待处理统计与未迁移提示 |
| `/pbot history list` | 列出当前布局下可用的摘要维度与说明 |
| `/pbot history {"action":"search"\|"read",...}` | 直接按查询契约检索或读取历史节点 |

## 可选历史与摘要配置（`.pbot/config.json`）

```json
{
  "enabled": true,
  "history": {
    "layout": "monthly"
  },
  "summary": {
    "backend": "pi",
    "model": "provider/model",
    "thinking": "low",
    "concurrency": 3
  }
}
```

- `history.layout` 可选 `"monthly"`（默认，按 UTC 年月分层）或 `"flat"`（平铺目录）；省略时默认为 `"monthly"`。读写与检索严格按当前配置布局执行，不混读两种布局。
- 已有平铺工作区在未迁移前运行于默认 `monthly` 布局时，启动提醒、`/pbot status` / `/pbot history status` 与 `pbot_history` 的 `warnings` 会提示运行 `/pbot history migrate` 或切回 `history.layout: "flat"`。
- `summary` 全部字段可选：省略 `summary` 或 `summary.backend` 时默认使用 `pi`；省略 `summary.model` 时使用目标 harness 的默认模型。

## 查询契约

| 能力 | 原生 `pbot_history` / MCP 工具 | 可选字段与默认值 |
| --- | --- | --- |
| 搜索 / 列会话 | `action: "search"` / `history_search` | `host`（如 `pi`、`dsh`、`claude`、`antigravity`，省略查全部）、`dimension`（`raw` 仅原文，或具体摘要维度如 `monthly`、`session`，省略查全部）、`query`（连续文本，不区分大小写；省略列会话或指定维度摘要）、`sessionId`、`from`、`to`（含时区 ISO 时间）、`offset=0`、`limit=20`（1–50） |
| 读取节点 | `action: "read"` / `history_read`（必填 `id`） | `host`、`offset=0`、`limit=12000`（1–24000 UTF-16 单元）、`childrenOffset=0`（每页固定 20 个子节点） |

- 搜索链路与写入/摘要生产完全隔离：关键词检索优先使用 `rg` 预过滤当前布局内的候选 JSON 文件（未安装 `rg` 或含特殊转义字符时自动回退到 Node 文本扫描），再对命中文件精确解析与分页。
- `read` 支持逐层下钻：月度汇总（`summary:monthly:<YYYY-MM>`）→ 单会话摘要（`summary:session:<rawId>`）→ 会话根（`<rawId>`）→ 单轮问答原文（`<rawId>:0:<entryId>`）。

## 存储布局与多维度扩展

- **默认年月分层（`history.layout: "monthly"`）**：
  - `.pbot/history/raw/<YYYY>/<MM>/<id>.json`（缺失有效时间戳时落入 `raw/unknown/<id>.json`）：全宿主原始问答与已知分支，固定按会话开始时间（最早 `from` 的 UTC 年月）落桶，后续跨月追加消息不移动目录。
  - `.pbot/history/summaries/<dimension>/<YYYY>/<MM>/<id>.json`（兜底 `unknown/`）：按维度存放的单会话级派生摘要产物（如 `session`）；月度汇总维度按年分目录存放为 `.pbot/history/summaries/monthly/<YYYY>/<YYYY-MM>.json`。
- **平铺布局（`history.layout: "flat"`）**：
  - `.pbot/history/raw/<id>.json` 与 `.pbot/history/summaries/<dimension>/<id>.json`；不启用 `monthly` 维度。
- 派生摘要按 `.write-summary-<dimension>` 短锁写入，记录来源指纹 `source.fingerprint` 以实现精确去重与增量更新，可随时删目录重算，损坏或缺失不影响原始问答查询；开发者可通过 `SummaryRegistry`（`registerSummaryDimension`）注册更多维度。
