# 技术设计

Personal Bot 提供按工作区加载的 Pi 扩展和原生 dsh Host/Web 接入。模型负责分析、协调和工具使用；扩展负责资料准备、专家会话和共享 Python 环境。安装与命令见[项目 README](../README.md)。

## 模块与依赖

```text
Pi / dsh 命令、工具、事件与原生 Remote
         ↓
 tools / extension / ui
         ↓
      services
      ↙      ↘
 storage   窄能力约定
               ↑
          integrations
```

src/pbot.ts 装配 Pi 入口，src/dsh.ts 装配 dsh Host，src/ui/dsh/index.ts 装配 Web 客户端；共享业务服务，不引入通用 Host 平台。src/extension/setup-cli.ts 装配独立安装命令；`pbot setup` 通过原生 npm/Pi 准备一个工作区，再启动 Pi 执行 `/pbot init`。安装器的顺序、来源保留与失败恢复由 services/installation 管理，接入层调用实际宿主的包管理接口，不创建模型会话。详见[安装与升级](installation-design.md)。

| 目录 | 责任 |
| --- | --- |
| src/tools/ | 输入、输出、schema、执行适配和工具列表 |
| src/services/ | 业务规则、状态变更和操作顺序，按 agents、workspace、history、installation 聚合 |
| src/model/ | 业务数据类型与窄能力约定，不包含业务实现或宿主 SDK 类型 |
| src/integrations/ | Pi/dsh 原生会话、Python 环境激活与进程执行 |
| src/storage/ | 原子 JSON、子会话与团队文件 |
| src/extension/ | 命令、事件和资源生命周期 |
| src/ui/ | 确认队列、对话框和专家展示 |
| src/common/ | JSON、校验、文件、包路径和版本辅助逻辑 |
| resources/ | 角色、技能、提示词、模板和参考资料 |

服务不依赖 Pi/dsh SDK、工具或 UI。共享进程执行可直接使用，其他宿主能力通过窄接口传入。接入层可引用服务类型；命令和工具通过服务执行状态变更。模型层用 interface/type 描述普通数据和窄能力契约；数据以普通对象进入 JSON、存储和工具结果。

| 主体 | 管理内容 |
| --- | --- |
| initializeWorkspace / prepareWorkspace | 初始化依次准备资料并写入共用启用配置；资料准备补建目录与根 AGENTS.md |
| PythonEnvironmentService | venv 准备、依赖检查、状态与取消等待 |
| AgentService / AgentRun | 原生专家实例、启动预约、代次、inbox、领取/进入/消费/完成与交付资格；拒绝向被团队占用的成员发送私人任务 |
| TeamService | 固定成员、公共消息、有限轮次、团队占用与暂停规则 |
| HistoryService | 双来源问答索引、四叉摘要、查询、来源写锁与过期提交拒绝 |
| WorkspaceInstance / DshWorkspaces | 各宿主工作区及资源生命周期；dsh 按父会话装配，并按工作区共享历史整理 |

## 加载与关闭

宿主原生配置决定插件加载范围，工作区根目录下的 `.pbot/config.json` 决定业务实例是否启动。`services/workspace/workspace-config` 为两种宿主读取同一 JSON；缺失、false 或无效配置保持未启用，错误由状态入口报告，不向父目录继承。规则与修改生效方式见[工作区配置](workspace-configuration.md)。

Pi 的 session_start 读取启动目录配置，仅在 enabled 为 true 时创建实例、注册工具和准备 Python。未启用时保留状态和初始化入口，不注册包内技能，也不注入 pbot 提示词；状态栏显示未启用或已启动。加载本身不开展模型任务。

Pi 的 `/pbot` 打开原生菜单，状态与长记录使用只读阅读页；dsh 使用独立工作台。见[界面设计](interaction-design.md)。

`/pbot init` 先准备资料，再将共用配置中的 enabled 设为 true，保留其他字段；无效配置在写入前报错。Pi 从未启用状态初始化后调用原生 ctx.reload，让实例、工具、技能和新建根 AGENTS 一起生效；已启动会话仅补建资料，新建 AGENTS 经 `/reload` 加载。`/pbot status` 展示运行状态、路径、版本和完整 Python 状态；模型环境只保留工作区、资源根目录及 Python 状态与就绪目录。实际 cwd 由宿主提供，准备错误日志保留在状态入口。

主 reload 在配置仍启用时保留子进程并重新关联，但暂停团队，不继续安排旧批次；配置关闭或损坏时停止所属专家；退出或切换会话时清理子进程、取消环境准备并恢复本实例持有的环境变量。关闭操作幂等。子会话的分支归属、通知和恢复规则见[专家协作](agent-collaboration.md)。

dsh 为原生 registry 中的每个根 Agent 读取其原始 cwd 下的配置，仅对已启用根目录建立协调者工作区。关闭的工作区保留只读状态和初始化入口，其余业务命令与 Remote 查询拒绝进入；init 写入配置后重新打开同一根目录下尚未启用的主会话，按目录合并并发初始化；首个已启用工作区触发共享 Python 准备。专家使用同进程独立 Agent/Session；组件或所属父 Agent 关闭时取消预约、暂停安排并等待自己拥有的执行资源释放。打开页面、轮询、重连不恢复专家或启动模型，已接纳工作不归浏览器生命周期所有。原生存在但由其他实例持有的专家不能替换或假称已释放。

## 资源加载

| 资源 | 用途与加载方式 |
| --- | --- |
| resources/prompts/workspace.md | 主会话与专家的公共操作约定、目录用途与异常重试说明 |
| resources/agents/、工作区 agents/ | coordinator、general-purpose 职责及同名工作区补充 |
| resources/prompts/team-member.md | 仅在专家处理团队任务时随团队目标与职责加载 |
| resources/prompts/history-summary.md | 两种宿主的独立历史摘要调用，不带主/专家上下文 |
| resources/skills/ | 原生技能目录只展示元数据，正文按需读取 |
| resources/references/ | 按任务读取；普通计算与指标/回测分开 |
| resources/templates/workspace-agents.md | 补建根资料入口的模板，不覆盖现有文件 |

Pi 包清单关闭包内技能的静态发现，已启用主会话通过 resources_discover 返回技能路径，再由原生加载器读取和去重。接入适配遵守 CLI `--no-skills` 与包级资源过滤；用户级过滤与项目 delta 保留各自优先级。专家按自己的 noSkills 选择发现包内及原工作区技能。Pi SDK 的 DefaultResourceLoader.noSkills 只关闭自动发现；SDK 宿主使用包级 skills 过滤控制这些显式动态路径，并绑定原生 commandContextActions.reload 以支持 init 后重载。before_agent_start 读取公共约定和角色补充，完整读取后更新 section；读取失败显式取消本轮，避免宿主只报告 hook 错误后继续。原生 AGENTS、技能元数据和提示模板由 Pi 自己加载、重载与去重；pbot 不另拼根 AGENTS，工具也不重复附加公共指南。

dsh 专家通过原生 composeFrom 应用父会话 preset，再限制其工具。包内技能 provider 仅在已启用主会话和受管专家的 scope 注册，原生文件系统 provider 负责读取和监听；作用域适配保留继承的项目/用户同名方法优先级；公共约定和角色在 system-prompt/assemble 当次刷新，遵守宿主 complete persona 覆盖。团队简报随首个已接纳团队上下文提供，不放在先于 pre-step 求值的动态 system section。

同一会话中不变的 section 由宿主沿用，有效系统内容随后续请求传递。团队公共消息按结构化来源与序号去重，压缩后需要的原文通过 read 续取。目录用途常驻，维护方法、接入、计算和调度细节按需读取。具体加载方式见[模型上下文](model-context.md)。

公共约定说明工作方式与资料位置，角色说明分工与交付，技能提供专业方法与必要的本地操作约定，工具定义参数与结果语义。委派包含文件修改时说明范围和责任；不重复加入通用授权、证据或验收要求。工具按 action 校验必填与允许字段，返回具体参数错误；status 不读取报告正文。Pi 附件组装保留绝对来源及原生读取结果；dsh 使用原生文件存储与图片准入，Web 通用文件走原生 Session 上传凭证，命令图片使用原生编码图片输入。资料保存由模型按公共约定与维护技能处理，沉淀方法、口径与结论，可再次查询的数据按需获取。布局见[文件存储](file-storage.md)。

## 历史查询

Pi 与 dsh 共用 `.pbot/history/`，共同查询归档，只收录和整理自己的原生来源。两种来源使用相同归档格式，顶层保存 `host`、`id`、`sessionId`、`name` 和 `nodes`；来源识别、读取筛选与写入校验使用必填的 `host` 字段。文件名与根 ID 一致，两端分别使用 `.write-pi`、`.write-dsh` 短写锁。

扫描与模型调用在短写锁外，提交时重读，拒绝过期原文或摘要覆盖。查询不调用模型；正常主交互结束后才在空闲阶段整理，新人工输入优先取消。dsh 使用原生 LLM 路由，不创建额外 Agent，也不写主聊天。原生会话缺失时保留现成归档；损坏文件单独报告，其他归档继续可查。有不可读归档时只更新已识别会话，避免为其原生会话重复分配根 ID。实现与限制见[历史对话](history.md)。

## 原生子会话存储

PiAgents 使用 `--session-id <agentId>` 启动新的原生会话，让 Pi 按子进程 cwd、环境变量和 settings 决定目录与文件名。AgentFiles 只保存 `session-ref.json`，初始路径为 null。子入口在首次输入前固定实际路径；已落盘会话在载入时绑定。Pi 延迟保存空会话，pbot 不写占位 JSONL 或伪造消息。

菜单进入已停止成员时，AgentService 复用重启校验与代次更新，但不入队输入，子进程保持待命；工具 resume 则明确入队新要求。菜单不再单独提供报告查看或恢复并继续。

恢复使用已绑定的绝对路径，不查找最近会话，也不因配置变化转用其他文件。AgentService 在更换 generation 和入队前要求 Pi 接入层验证文件、session ID 与 cwd。引用绑定后文件不可读取时保守失败，不将未知历史当作空白待命。父侧报告读取使用原生解析器和内存 SessionManager，不改写或迁移原生文件。

会话文件移出控制目录的恢复契约在 0.2.0 引入。旧兼容线不进入当前列表或后台调度；不导入、迁移或删除旧记录。既有控制字段、团队调度及完成叶节点关联保持不变。

dsh 的 `native-session.json` 只保存原生 Session ID，不把它写入 Pi 路径字段。先持久化父会话，再创建并持久化空专家；冷读、恢复校验和固定 `dsh:<turn/end seq>` 报告均使用公开 Session API。恢复保留原生模型选择，清除旧 inbox，只接纳新代次的新请求。双方不接管对方的会话。

## 团队接入

团队采用独立 team.json，不改动旧 AgentMessage、AgentCycle 等持久结构。TeamService 接收普通成员状态与完成记录，安排 roundRobin 或 parallel 轮次；AgentService 再校验并写入原 inbox。父侧原扫描器收集固定叶节点报告并公开原文，不调用主模型转述，不另建执行器或事件总线。

团队关联先保存，再发布输入。跨文件窗口采用保守恢复：不自动重发旧请求，只补交付可核对的完成记录。主/子工具显式注册，子入口只有公共 read/post。Pi 的上下文注入和通知边界分别位于 subagent-entry、agent-events 与 integrations/pi/team-context，服务不持有宿主 ctx。dsh 在原生 pre-step 安全边界注入团队上下文，以持久事件区分领取、进入、消费与正常最终答复；团队投递先取得原生 maintenance 准入，不能把公开 idle 当作独占许可。

模型可读的团队任务、背景、公共原文和批次通知使用 Markdown；公共消息 read 复用同一原文渲染。主 agent 收到的独立子会话结果通知，以及 agent/team 工具的列表、状态和报告文本也使用 Markdown。common/markdown 提供字段与原文区块渲染，tools/result 只为这些工具显式选择 Markdown 文本。上下文预算计入实际 Markdown、原文围栏与分页字段。工具 structuredContent、原生 custom message 的去重 details 和控制文件继续使用原有结构化字段，运行时不解析 Markdown 来识别团队或请求。

## dsh 人工管理

原生 `/pbot` 命令与模型工具调用同一业务动作。四个共享 Remote 描述符提供 snapshot、expert、team、history 查询，Host 注册，Client 原生 `$mount`；不增加 HTTP 服务。查询核对已加载的根父会话及领域归属；完整专家记录只读分页，不代替模型 read 领取通知。

Web 拥有草稿、上传和查询；接纳后的命令归服务端。命令不重复记录私人输入正文，人工对话要求团队暂停成功后才进入 inbox。原生工具成功读取或上下文实际消费才确认通知；PTC 内层 read 还要求根调用成功，页面读取不确认。

## Python 环境

所有工作区共用当前用户的 venv。PythonEnvironmentService 调用 scripts/setup-python.py，按 python/requirements.lock 创建或对齐依赖，完成 pip check、库导入和基础计算检查后标记就绪。安装仅使用 wheel。

共享锁串行化跨进程 setup，同一服务合并重叠请求。失败或取消时保留环境并报告状态，其他扩展功能继续可用；可通过 `/pbot python setup` 重试。

各宿主装配在当前进程激活 PATH、VIRTUAL_ENV 和 Python 路径变量，供主会话与专家的 Bash 继承；同一 dsh 进程内的工作区共用准备与激活生命周期。关闭时恢复仍由本实例持有的变量。环境更新会影响其他工作区，更新前应停止相关脚本。

计算通过原生 Bash 和第三方库 API 执行，使用项目自身的目录、输入和输出约定。路径、安装条件与许可见 [Python 说明](../python/README.md)。

## 工具与分发

Pi 将工具纳入 pbot namespace，codemode 按契约组合；dsh 注册原生工具，并在宿主可表达的 schema 之外继续校验完整领域契约。原生 CLI/MCP 与可选 Task Conductor 的接入和授权见[工具与执行](capability-design.md)。

Pi 入口指向 src，由宿主加载 TypeScript 源码；独立 CLI 与 dsh Host/Web 编译到 lib，dist 供测试使用。宿主 SDK 使用 optional peer，dsh SDK 范围为 "*"，最低宿主版本由 engines.dsh 声明；开发依赖和锁文件保留精确版本。TypeBox 同样为 optional peer：Pi 通过宿主加载器提供，dsh 构建携带库及许可证，并保留原模块路径以定位资源。

Pi/CLI 支持 Node.js 22.19+，dsh 与完整开发使用 Node.js 24.9+。安装检查发现真实宿主后，在子进程中使用其 SDK 读取配置或切换来源。包内组件共用 package.json 的发布版本；子会话兼容线在 1.0 前按次版本、之后按主版本判断。

构建与安装包检查见[维护脚本](../scripts/README.md)，分发流程见[npm 发布](release.md)。
