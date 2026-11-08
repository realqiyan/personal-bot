# dsh 使用说明

[English](dsh.en.md) | 简体中文

Personal Bot 使用 dsh 原生 Web 界面，提供工作区资料、专家、团队、历史查询和 Python 环境。它与 Pi 共用资料、角色、方法及协作规则，各自管理原生会话、模型配置、认证与 MCP。

安装和更新使用 dsh 最新版，最低宿主版本为 `0.2.2-rc.1`。本文区分终端命令与聊天框中的 `/pbot` 命令，升级后可查看实际安装版的帮助。

## 安装与首次启动（CLI + 浏览器）

需要 Node.js 24.9+、npm、pnpm，以及 Python 3.11+ 和 venv/ensurepip。新版本的 Node.js 要求以 dsh 的 engines 为准。安装使用原生插件与 profile：

```bash
npm view @deepseek-ai/dsh@latest version engines --json
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# 仅首次创建；会覆盖已有同名 profile
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

`pbot` 是可自选的 profile 名称，后续命令应保持一致。已有 profile 更新时不要重复执行 `--from-default-profile`。

dsh 启动 Web 服务并通常自动打开浏览器。SSH 或 `--no-open` 模式下手动打开输出的 URL；该地址含访问令牌，应妥善保管。选择工作区和主会话，配置模型与认证，再在聊天框执行：

```text
/pbot status
/pbot init
/pbot
```

`status` 查看状态；`init` 可选地补建资料目录和根 AGENTS，保留已有文件；裸 `/pbot` 打开管理界面。加载插件会自动准备当前用户共享的 Python venv。准备失败时修复基础环境，再运行 `/pbot python setup`。

一个 profile 可管理多个工作区。通过原生工作区选择器指定目录；默认使用系统 Documents。pbot 绑定主会话创建时的根目录，后续 cwd 变化只影响相对路径解析。

## 日常启动与终端命令

已有 profile 直接启动，前台运行时用 `Ctrl+C` 停止服务：

```bash
dsh --profile pbot
# 指定端口且不自动打开浏览器
dsh --profile pbot --port 8080 --no-open
```

启动器参数放在 Web 参数之前。下表中的配置查看命令用于已有 profile；不要附加 `--from-default-profile`，除非确实要重建。

| 命令 | 用途 |
| --- | --- |
| `dsh --version` / `dsh -V` | 查看实际宿主版本 |
| `dsh --help` | 查看启动器帮助 |
| `dsh --profile pbot --help` | 查看该 profile 的 Web 参数 |
| `dsh plugin --help` | 查看插件命令入口帮助 |
| `dsh --profile pbot` / `dsh pbot` | 启动已有 profile |
| `dsh --profile pbot --dump-config` | 打印合成配置并退出，不启动服务 |
| `dsh --profile pbot --dump-default-config` | 查看 bundle 配置，不加入用户覆盖及命令行 patch |
| `dsh --profile pbot --dump-config-schema` | 导入插件 schema 并打印配置结构，不启动服务；仅用于可信插件 |
| `dsh --profile pbot --patch /absolute/path/extra.yml` | 本次启动叠加 patch，可重复传入，放在 Web 参数之前 |

三个 `--dump-*` 选项互斥，配置输出可能含私有设置。原生 profile 配置归 dsh 管理，不是 pbot 工作区文件。

| Web 参数 | 用途 |
| --- | --- |
| `--port 8080` | 指定端口，默认 3080；`--port 0` 由系统选择空闲端口 |
| `--no-open` | 启动服务但不自动打开浏览器 |
| `--host 127.0.0.1` | 绑定一个具体本机 IPv4/IPv6 地址；默认回环，不接受 `0.0.0.0` 或 `::` 等通配地址 |
| `--public-url https://app.example/` | 指定对外访问 URL，不自动配置代理或授予访问 |
| `--trusted-host app.example` | 增加原生 Host/Origin 检查允许的主机名或主机名与端口 |
| `--tls-cert /path/server-chain.pem --tls-key /path/server-key.pem` | 成对指定证书链与未加密 PEM 私钥，为监听服务启用 HTTPS |

远程部署的代理、网络访问与认证设置见 [dsh 原生 Web 文档](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/bundle/web-app)。

## 更新、查询与移除插件

宿主、pnpm 和 profile 中的插件分别更新。先暂停团队、等待在途工作结束并停止活动专家，再用 `Ctrl+C` 停止对应服务，执行：

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
dsh plugin --profile pbot update personal-bot --latest
dsh --version
pnpm --version
dsh plugin --profile pbot list personal-bot --depth 0
dsh --profile pbot
```

`update personal-bot --latest` 只选择 Personal Bot 更新到当前 `latest`，允许越过原先保存的版本范围；不带 `--latest` 的 update 受已有声明限制。更新后用 `/pbot status` 核对版本与环境，旧专家需显式恢复。停用或重载插件也可能释放专家。

`dsh plugin --profile pbot` 后面的包管理参数交给 pnpm，必须选对 profile：

| 命令 | 用途 |
| --- | --- |
| `dsh plugin --profile pbot list --depth 0` | 查看 profile 的直接依赖 |
| `dsh plugin --profile pbot list personal-bot --depth 0` | 查看已安装 Personal Bot 版本 |
| `dsh plugin --profile pbot outdated personal-bot` | 查询可用更新；发现旧版本时可能返回非零退出码 |
| `dsh plugin --profile pbot why personal-bot` | 查看包的依赖来源 |
| `dsh plugin --profile pbot add personal-bot@latest` | 从 registry 安装 Personal Bot |
| `dsh plugin --profile pbot update personal-bot --latest` | 更新该插件 |
| `dsh plugin --profile pbot remove personal-bot` | 从该 profile 移除插件；先停止其工作，不删除工作区和历史 |
| `dsh plugin --profile pbot version-exemptions` | 查看该 profile 已保存的原生兼容例外 |

临时停用、重新启用与桌面安装也可在原生“插件”页面操作。插件开关影响同一 profile 下的会话。版本不兼容时先核对 `dsh --version`、已安装包版本和发布说明；不要把兼容例外当作常规更新步骤。原生 `allow-version` / `revoke-version` 的精确版本操作见[兼容说明](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/boot/plugin-manager#version-compatibility-and-exemptions)。

## 从源码安装

开发或验收时，在仓库目录生成包含 CLI、Host 和 Web 产物的 tarball：

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm pack
```

`npm pack` 会通过 prepack 执行检查和构建。用实际产物的绝对路径安装到已创建的 Web profile：

```bash
dsh plugin --profile pbot add /absolute/path/to/personal-bot-<version>.tgz
dsh --profile pbot
```

本地来源更新时重新构建并安装 tarball。切回 registry 来源时运行 `dsh plugin --profile pbot add personal-bot@latest`。

## 桌面应用

在 DeepSeek Harness 的“插件 → 添加插件”中安装并启用 `personal-bot@latest`，也可输入本地 tarball 的绝对路径。应用提供运行时和包管理，宿主与插件分别通过应用更新。

桌面应用使用独立的 desktop profile；CLI 的 pbot profile 分开管理。应用从登录 Shell 读取环境，Python 3.11+ 应在该 PATH 中可见。安装后选择工作区和主会话，用 `/pbot status` 检查环境。

## Task Conductor

周期任务、重复流程和 DAG 使用可选的 `task-conductor-plugin`。插件与服务分别安装，配置和更新见[上游接入指南](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md)。

dsh 接入包含于尚未发布的 Task Conductor 0.1.6 候选版本。发布前从同一源码构建插件和服务：

```bash
cd /absolute/path/to/task-conductor
npm ci --ignore-scripts
npm pack
npm run pack:plugin
```

使用实际生成的 tarball 路径安装：

```bash
dsh plugin --profile pbot add /absolute/path/to/task-conductor-plugin-<version>.tgz
npm install -g /absolute/path/to/task-conductor-<version>.tgz
task-conductor setup
```

已有服务按[上游升级步骤](https://github.com/realqiyan/task-conductor/blob/master/docs/upgrades.md)更新，保留原服务目录与数据。桌面用户在应用的插件页安装同一插件包。

重启宿主后，在主会话读取 `/using-task-conductor`；用 `/task-conductor status` 查看连接，修复配置后用 `/task-conductor connect` 重连。插件创建原生 MCP 连接，已有同名连接先按上游指南调整来源。

任务通知回到提交任务的原会话。关闭页面或宿主后服务任务继续运行，当前 run 与未来周期分别查询、停止。

使用 dsh 执行任务节点时，按上游[自定义 ACP 方法](https://github.com/realqiyan/task-conductor/blob/master/plugin/skills/using-task-conductor/references/custom-acp.md)注册 `dsh-acp`，提供 dsh 的规范绝对可执行路径和 `["--profile", "acp"]` 参数。节点的模型、工具、认证和 Python 环境单独配置。

## 管理界面与生命周期

在原生输入框选择不带参数的 `/pbot`，打开四个页签：

| 页签 | 操作 |
| --- | --- |
| 工作区 | 来源、目录、模型、Python 和历史整理状态；准备资料或重试 Python |
| 专家 | 创建、重命名、停止、显式恢复；人工对话、附件和完整原生记录 |
| 团队 | 固定成员与职责、有限轮次、暂停、关闭、公共原文和长消息分页 |
| 历史 | 按 Pi/dsh 来源与时间查询，读取问答和摘要，沿父子节点导航 |

宽窗口使用侧边导航，窄窗口使用顶部导航。专家支持名称与状态筛选；草稿与附件按专家保留，团队草稿分别保留。

页面通过原生 Remote 查询，不启动专家、领取模型通知或生成摘要。人工命令会保留原生审计记录。关闭面板会取消尚未接纳的上传；关闭、刷新或重连页面不停止已经接纳的工作。结果不明确时先查询状态与记录，再决定后续动作。

服务端组件停用、所属父 Agent 释放或整个桌面应用退出，会暂停安排并释放其拥有的专家。重新打开页面、重启宿主或启用插件只读取保存记录，需要明确恢复才继续工作。

主会话使用原生 write、edit、apply_patch 修改原工作区外文件时要求一次原生批准；专家的这些工具拒绝越界修改。Bash、Python、MCP 和扩展使用实际账户权限，详见[工具与执行](capability-design.md)。

## 聊天命令总表

以下命令在 dsh 聊天输入框执行，不在终端执行。JSON 必须是一个对象，属性名用双引号；把示例中的 `AGENT_ID`、`TEAM_ID`、`NODE_ID` 替换为实际返回值。除裸 `/pbot` 的 Web 动作外，命令返回 JSON 文本。

| 命令 | 用途 |
| --- | --- |
| `/pbot` | 在 Web 中打开管理界面；服务端直接执行空参数命令时返回 status |
| `/pbot status` | 查看工作区、版本、模型、Python、历史、专家和团队状态 |
| `/pbot init` | 可选地补建资料目录与缺失的根 `AGENTS.md` |
| `/pbot python setup` | 重试共享 Python 环境准备并在当前 Host 进程激活 |
| `/pbot agent {"action":"list"}` | 专家管理，全部 action 见下表 |
| `/pbot chat {"agentId":"AGENT_ID","text":"补充要求"}` | 人工对话，可附文件；自动先暂停所属团队 |
| `/pbot records {"agentId":"AGENT_ID"}` | 读取专家完整原生事件记录 |
| `/pbot team {"action":"list"}` | 团队管理与公共消息读取 |
| `/pbot post {"teamId":"TEAM_ID","text":"公开信息"}` | 以人工用户身份发布公共消息，不唤醒模型 |
| `/pbot history {"action":"search"}` | 查询历史归档；也支持 read |

`chat`、`post`、`records` 不带 `action`。dsh 没有 `/pbot help`、`/pbot agents` 或 `/pbot teams` 子命令；后两个复数入口属于 Pi。

## 专家命令

`/pbot agent` 与模型工具 `pbot_agent` 使用相同输入契约，拒绝未知及跨 action 字段：

| action | 除 action 外必填字段 | 可选字段 | 用途 |
| --- | --- | --- | --- |
| `start` | 无 | `name`, `message`, `prompts`, `files`, `provider`, `model`, `thinking`, `cwd`, `tools`, `noSkills` | 创建专家，接纳后返回，不等待完成 |
| `list` | 无 | 无 | 列出当前父会话的专家 |
| `status` | `agentId` | 无 | 查看执行与最近周期状态，不读报告正文 |
| `send` | `agentId`, `message` | `delivery` | 向存活专家追加委派任务 |
| `rename` | `agentId`, `name` | 无 | 重命名 |
| `read` | `agentId` | `cycleId`, `offset`, `limit` | 非阻塞读取一个工作周期的最终报告 |
| `stop` | `agentId` | 无 | 请求停止并保留历史；可能仍处于 stopping |
| `resume` | `agentId`, `message` | 无 | 已停止专家携新要求恢复，不重放旧任务 |

`start` 不带初始文字或文件时只创建待命专家，不调用模型；但仍须继承或显式提供有效的 provider/model 选择。先在 dsh 中选模型。每个父会话最多 50 个存活、启动中或释放中的专家；专家使用同进程独立 Agent/Session，不需 tmux，也不继承父聊天历史。

| 启动参数 | 说明 |
| --- | --- |
| `name` | 1–64 字符的单行名称，省略使用 ID 前 8 位 |
| `message`, `prompts` | message 和每条 prompt 各为 1–24000 字符；prompts 最多 32 条，按 message、prompts 顺序合并成一次输入 |
| `files` | 最多 32 个服务器文件路径，相对原工作区根目录；可只带文件启动任务 |
| `cwd` | 默认原工作区根目录；相对路径也以该根目录解析 |
| `provider`, `model` | dsh 原生 provider route 与模型 ID，各 1–128 字符，默认继承父会话选择 |
| `thinking` | dsh 原生 reasoning effort ID；换 provider/model 时不自动继承另一模型的 effort |
| `tools` | 非空的原生能力工具名数组，不用 `run_code` 传输名；团队成员需保留 `pbot_team_message` |
| `noSkills` | 默认 false；true 关闭该专家的模型技能目录与 skill 工具，用户显式技能命令仍按宿主处理 |

专家创建和恢复时应用父会话的原生 preset，保留其文件工具、AGENTS 和技能发现，再应用专家工具限制。显式 complete persona 由宿主按其完整配置提供行为要求。

Pi 专属的 `noExtensions`、`noPromptTemplates`、`noContextFiles` 在 dsh 中拒绝。`send.delivery` 为 `steer`（默认，补充当前工作）或 `followUp`（当前工作之后）。`send/resume` 不支持 files、prompts 或模型切换参数。成员被团队占用时私人 send 被拒绝，应先 pause 并等在途工作结束。

```text
/pbot agent {"action":"start","name":"证据核对"}
/pbot agent {"action":"send","agentId":"AGENT_ID","message":"核对资料来源，列出缺失证据。","delivery":"followUp"}
/pbot agent {"action":"rename","agentId":"AGENT_ID","name":"来源复核"}
/pbot agent {"action":"status","agentId":"AGENT_ID"}
/pbot agent {"action":"read","agentId":"AGENT_ID","offset":0,"limit":4000}
/pbot agent {"action":"stop","agentId":"AGENT_ID"}
```

确认专家已停止后，可携新要求恢复：

```text
/pbot agent {"action":"resume","agentId":"AGENT_ID","message":"核对新增资料，只报告变化。"}
```

报告 read 默认选择最近周期，offset 默认 0，limit 默认及上限均为 16000，最小 1，单位为 UTF-16 代码单元。续读固定返回的 `cycle.cycleId`，并把 `nextOffset` 传回 offset；null 表示当前报告读完。工作结果查看 `cycle.state` 与报告；人工读取保留模型的完成通知。

## 人工对话与完整记录

`/pbot chat` 必填 `agentId`，可选 `text`、`delivery` 和 `files`；必须至少有非空文字、服务器文件或原生输入框附件之一。text 最多 24000 字符，delivery 为 `steer`（默认）或 `followUp`。它使用 `text`，不是 agent 命令的 `message`。

```text
/pbot chat {"agentId":"AGENT_ID","text":"核对附件中的口径。","delivery":"steer","files":["projects/review/notes.txt"]}
/pbot records {"agentId":"AGENT_ID","offset":0,"limit":30}
```

chat 的相对文件路径以专家创建时固定的 cwd 为基准。服务器 files 与本机输入框附件二选一，每次最多 32 个；图片格式及字节上限遵循宿主准入。上传附件使用原生输入框，不传 JSON `attachments` 字段。chat 自动先暂停所属团队，暂停失败不接纳输入；成功后可对在途工作 steer。返回 queued 仅表示入队。人工接管的 interactive/mixed 周期不自动公开；需要独立保密上下文时新建专家。专家必须存活，停止后先 resume。

`records` 读取完整事件，不等同于 `agent read` 的最终报告；停止后可冷读，不恢复专家或领取通知。

| 读取方式 | 请求字段与默认值 | 续读 |
| --- | --- | --- |
| 事件列表，不传 seq | `agentId`；`limit=30`，范围 1–100 条；offset 默认最近一页，显式 `offset=0` 从头读取 | 返回 events、total、nextOffset；nextOffset 回填 offset |
| 单条事件，传 seq | `agentId`, `seq`（列表返回的序号，≥0）；`format="json"` 或 `"text"`；`textOffset=0`；`textLimit=12000`，范围 2–24000 | 保持 seq/format，将返回的 nextOffset 回填 **textOffset** |

单条正文按 UTF-16 代码单元分页；text 格式无可提取文本时回退 JSON。传 seq 后用 textOffset/textLimit，不再使用列表 offset/limit。下面的 seq 应替换为列表返回值：

```text
/pbot records {"agentId":"AGENT_ID","seq":0,"format":"json","textOffset":0,"textLimit":12000}
```

## 团队与公共消息

`/pbot team` 与模型工具 `pbot_team` 的 action 相同：

| action | 除 action 外必填字段 | 可选字段 | 用途 |
| --- | --- | --- | --- |
| `create` | `name`, `brief`, `members` | 无 | 创建固定成员团队，不调用模型 |
| `list` | 无 | 无 | 列出团队 |
| `status` | `teamId` | 无 | 查看批次、占用和未确认结果 |
| `read` | `teamId` | `afterSeq`, `seq`, `offset`, `limit` | 读取公共原文 |
| `run` | `teamId`, `instruction`, `mode` | `rounds`, `maxConcurrent`, `timeoutSeconds` | 开始新批次 |
| `pause` | `teamId` | 无 | 停止新安排，允许在途收尾 |
| `close` | `teamId` | 无 | 无运行批次及在途请求时关闭，保留成员和历史 |

create 的 name 为 1–64 字符单行名称，brief 为 1–24000 字符。members 为 1–50 个 `{agentId,role}`，role 为 1–4000 字符；成员不可重复，须属于当前父会话，且不能已在另一未关闭团队中。换成员需关闭旧团队后新建。

run 的 instruction 为非空文字，最多 24000 字符。mode 必填：`roundRobin` 轮流执行，并发为 1；`parallel` 并行执行，每轮全部结束后进入下一轮。rounds 默认 2，范围 1–10；parallel 的 maxConcurrent 默认 min(2,成员数)，范围 1–50 且不超过成员数。timeoutSeconds 默认 900，范围 1–86400，是整批期限。run 要求成员存活、空闲、团队接入就绪且无待处理私人输入。

先创建两个专家，再用其实际 ID 创建团队：

```text
/pbot team {"action":"create","name":"资料复核","brief":"检查证据质量与结论边界。","members":[{"agentId":"AGENT_A","role":"核对原始来源"},{"agentId":"AGENT_B","role":"复核假设与反例"}]}
/pbot post {"teamId":"TEAM_ID","text":"只使用提供的资料，明确列出证据缺口。"}
/pbot team {"action":"run","teamId":"TEAM_ID","instruction":"各自给出发现与未决问题。","mode":"parallel","rounds":1,"maxConcurrent":2,"timeoutSeconds":900}
/pbot team {"action":"status","teamId":"TEAM_ID"}
/pbot team {"action":"read","teamId":"TEAM_ID","afterSeq":0,"limit":4000}
/pbot team {"action":"pause","teamId":"TEAM_ID"}
```

pause 不停止专家；等待 status 的 `activeCount=0` 后才可 close：

```text
/pbot team {"action":"close","teamId":"TEAM_ID"}
```

没有 team resume；继续时用新 instruction 发起 run。paused 仍可能有在途请求；unresolved 可包含失败、未知或混合输入，继续前先查询报告与实际状态。正常完成的纯团队答复才自动公开。完整规则见[专家协作](agent-collaboration.md)。

`/pbot post` 必填 teamId、非空 text（最多 24000 字符），可选 `replyTo` 引用已有消息 seq（≥1）。返回 stored 只表示保存，不唤醒模型或增加轮次；关闭团队不能再 post。人工作者为 user；模型 `pbot_team_message` 必须带 `action:"post"` 或 `action:"read"`，作者由服务确定为 coordinator/member。

公共消息 read 的 afterSeq 默认 0，只返回后续消息；seq 从 1 开始，可指定单条。offset 默认 0，非零时必须同时指定 seq。limit 默认及上限为 16000，最小 1，是正文合计的 UTF-16 代码单元数，不是消息条数。先按消息的 `nextOffset` 固定 seq 读完正文，再将列表的 `nextAfterSeq` 传回 afterSeq 继续列表。

## 历史查询

`/pbot history` 与模型工具 `pbot_history` 支持以下有效参数：

| action | 必填字段 | 可选字段与默认值 |
| --- | --- | --- |
| `search` | action | `host` 为 pi/dsh，省略查两者；`query`, `sessionId`, `from`, `to`；`offset=0`；`limit=20`，范围 1–50 条 |
| `read` | action、`id` | `host`；`offset=0`；`limit=12000`，范围 1–24000 UTF-16 代码单元；`childrenOffset=0`，子节点每页固定 20 个 |

query 按不区分大小写的连续文本搜索已就绪问答与摘要；省略或空白时列出会话。sessionId 是原生会话 ID；read 的 id 是返回的归档节点 ID，不是专家 ID。日期字段是 **from/to**，不是 start/end，使用明确时区的 ISO 时间。仅日期的 to 如 `2026-11-07` 表示 UTC 零点，不自动包含当日全天。

```text
/pbot history {"action":"search","host":"dsh","query":"证据","from":"2026-11-01T00:00:00+08:00","to":"2026-11-07T23:59:59.999+08:00","offset":0,"limit":20}
/pbot history {"action":"read","host":"dsh","id":"NODE_ID","offset":0,"limit":12000,"childrenOffset":0}
```

search 返回 matches、total、nextOffset 和 warnings，续页保持筛选条件并回填 nextOffset。read 返回 node：`node.nextOffset` 用于正文 offset，`node.nextChildrenOffset` 用于 childrenOffset；沿 parents/children 的 id 继续读取。没有 childrenLimit 参数。摘要提供线索，关键事实应回到问答原文；历史归档不能替代专家完整工具记录。

Pi 维护 `.pi/pbot/history/`，dsh 维护 `.dsh/pbot/history/`。两者共同查询已有归档，只更新和整理自己的来源。查询不调用模型；正常主交互结束后的空闲阶段才使用当前宿主模型补齐摘要，新人工输入优先取消整理。详见[历史对话](history.md)。

## 模型工具

| 工具 | 操作 |
| --- | --- |
| `pbot_agent` | start、send、rename、status、list、read、stop、resume |
| `pbot_team` | create、list、status、read、run、pause、close |
| `pbot_team_message` | read、post；read 分页同 team read，post 使用 teamId/text/可选 replyTo |
| `pbot_history` | search、read |

模型使用实际工具 schema；人工使用上面的命令或管理页。chat、records 是人工管理入口，没有同名模型工具。
