# 历史对话

所有宿主（Pi、dsh、Claude Code、Antigravity 及自定义插件宿主）共用工作区 `.pbot/history/` 归档原始问答与多维度摘要：

- **统一 RAW 采集**：各宿主在主会话输入与回合结束时直接写入 `.pbot/history/raw/`（默认按会话开始时间 UTC `YYYY/MM/` 分层），工具调用、推理与子会话均不写入历史。
- **独立 Worker 摘要生成**：所有宿主均可通过 `pbot history summary`（Pi / dsh 也提供 `/pbot history summary`）主动扫描 `.pbot/history/raw/`，为每个待摘要项启动**独立的临时 ACP worker**（默认 `backend: "pi"`，使用 Pi 当前默认模型；带 `PBOT_SUBAGENT_RUN_ID` 隔离，绝不写回 `raw/`，不挂载工作区 MCP/技能，跑完即销毁）。可在 `.pbot/config.json` 的 `summary` 字段中设置 `backend`、`model`、`thinking` 与 `concurrency`；命令行可覆盖前三项。
- **独立只读搜索**：Pi 与 dsh 提供原生 `pbot_history` 工具（dsh 另提供 Web 工作台“历史”页与 `/pbot history {"action":...}` 命令）；Claude Code、Antigravity 与其他插件宿主通过 `pbot` MCP 提供的 `history_search` / `history_read` 检索全部宿主的原始问答与各维度摘要。
- **开关控制**：在 `.pbot/config.json` 中设置 `features.history: false` 可关闭当前工作区的历史采集、摘要生成与查询入口（默认 `true`）。
- **启动提醒**：会话启动时自动探测历史目录；当存在未迁移的旧平铺文件（`monthly` 布局下）或原始历史累计满 7 天且近 7 天未更新摘要时，给出一次性轻量提示。

## 所有宿主共用的 CLI

全局安装用 `npm install -g personal-bot`，然后运行 `pbot`。临时运行用 `npx --yes personal-bot@<插件的确切版本>` 替换命令中的 `pbot`。CLI 支持 Linux/macOS、Node.js 22.19+ 和 npm；摘要还需要所选 ACP 后端已安装并完成认证。

```sh
pbot init --workspace ~/notes
pbot status --workspace ~/notes --json
pbot history status --workspace ~/notes
pbot history summary --workspace ~/notes
pbot history search "评审决定" --dimension session --limit 10 --workspace ~/notes --json
```

每个命令只处理 `--workspace` 指定的根目录，省略时使用进程启动目录。相对路径相对于启动目录。宿主从会话取得根目录后显式传入。工作区未启用、配置损坏或 `features.history: false` 时，历史命令返回错误；只有显式 `init` 才初始化工作区。

| 命令 | 作用 |
| --- | --- |
| `pbot init` / `pbot status` | 初始化共享资料并启用工作区，或只读查看根目录、运行版本、各宿主登记的版本和配置 |
| `pbot history status` / `list` | 查看布局、会话数与各维度已就绪、待处理数量，或列出可用维度 |
| `pbot history summary [维度...] [--force] [--backend <acp>] [--model <模型>] [--thinking <级别>]` | 默认增量整理；`--force` 强制重建。默认年月布局依次整理会话和月度摘要 |
| `pbot history migrate [--dry-run]` | 预览或显式迁移旧平铺文件；保留冲突目标，报告逐项结果 |
| `pbot history search [关键词]` | 省略关键词列会话，支持 `--host`、`--dimension`、`--session-id`、`--from`、`--to`、`--offset` 和 `--limit` |
| `pbot history read <节点ID>` | 按搜索结果 ID 读取正文及上下级，支持 `--host`、`--offset`、`--limit` 与 `--children-offset` |

CLI 默认输出缩进 JSON；`--json` 输出单行 JSON 到 stdout，生成进度和诊断进入 stderr。摘要有失败项、迁移有错误或目标冲突时，退出码非零，逐项报告仍在 stdout。按 Ctrl-C 取消，已发布的摘要可供下次增量运行复用。Pi 和 dsh 保留原有 `/pbot history` 命令和 JSON 查询语法。

### CLI 版本选择

显式运行 `init` 或在已启用的工作区执行命令时，CLI 从目标根目录的 npm、Pi 本地安装清单和宿主登记的插件中取最高版本。配置缺失、停用或损坏时，`status` 用当前 CLI 报告配置，`plugins` 为空对象，`minimumCliVersion` 为 `null`。关闭 `features.history` 后，历史命令直接报告功能已停用。`pbot --version` 显示当前 CLI 的版本，`pbot --at-least <版本>` 在本地比较版本，满足要求时返回 0。

宿主按用户、规范化工作区路径和宿主名，将插件绑定保存在 `~/.pbot/workspaces/`。目录只读时宿主仍可运行。CLI 重读可访问的绑定和安装清单，跳过已移除的清单。只提供发布版本的轻插件在下次绑定时刷新记录。宿主也可通过 `PBOT_PLUGIN_VERSION` 传入其确切版本。

满足最低版本时直接运行。版本不足时，npm 管理的全局安装会原位更新到所需版本，再按原参数和工作目录执行。项目依赖、npm link、npx 安装以及另一个进程正在更新或无法加锁的全局前缀，使用 npm 的版本缓存自动安装或复用所需版本，保留项目依赖与锁文件。更新失败时返回非零，原操作停止。已有 0.3.2 及更早的全局启动器需要先安装一次带升级功能的版本，或直接使用新版插件给出的精确版本 npx 命令。

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
