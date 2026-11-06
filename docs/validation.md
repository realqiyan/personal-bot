# 验证

## 本地检查

```bash
npm run check
npm test
git diff --check
npm pack --dry-run
```

完整开发与验收使用 Linux、Node.js 24.9+；Pi 与独立 CLI 消费路径保留 Node.js 22.19+。CI 使用 Node 24.x 安装完整开发依赖、执行全量检查并构建候选包，再由独立 Node 22.19.0 作业安装同一 tarball，检查无宿主 SDK 的 CLI 与显式安装 Pi SDK 后的扩展、工具、技能及资料初始化。消费者检查不安装 dsh 开发依赖，也不调用模型。npm test 先构建 dist 和 CLI、dsh Host/Web 的 lib，再串行执行 Node 测试。测试使用真实本地文件、进程、计算、Pi 1.5.0 与开发基线 dsh 0.2.2-rc.1 SDK。Pi 开发依赖与相关传递组件统一锁定 1.5.0；宿主提供的包声明为 optional peer，不增加运行时副本。发布包包含 bin/lib，扩展仍由 Pi 加载 src，dist 不进入发布包。

| 范围 | 检查内容 |
| --- | --- |
| 领域与基础模块 | 工具契约、状态转换、版本兼容、原子保存和非法路径 |
| tests/installation/ | 真实子进程、Pi 原生配置、来源与资源过滤保留、过期计划、CLI 打包入口、无模型认证时的初始化分发与拦截 |
| tests/smoke/ | 实际 tarball 加载、资料准备、独立 Python setup 脚本 |
| tests/e2e/ | Pi SDK/RPC 命令与工具、确认、持久化、重启和 Bash 环境继承 |
| tests/integration/ | Pi 首轮上下文、原生差量、技能禁用与包过滤、init 后的原生 reload、必需资料读取失败时取消 |
| tests/dsh/ | 真实 Agent/Session、代次与占用、附件、文件规则、团队、通知、双来源 history、原生 Remote、preset 继承、资源可见性与生命周期 |
| 历史并发 | 真实多进程与来源短锁，拒绝过期扫描和摘要覆盖，损坏来源隔离与独立取消 |
| 专家协作 | 真实 tmux/Pi 进程、无任务待命、原 inbox、消息顺序、分支归属、通知领取和异常退出 |
| 历史查询 | 真实 SDK 保存的问答、补充输入、工具过滤、分支隔离、四叉分组、原文与摘要搜索、正文分页、重载复用、空会话不误报、旧目录复制、跨目录读取、缺失原文时保留存档、旧路径清理、按会话 ID 重新关联与工具契约 |
| 原生会话存储 | 真实 CLI 的默认 cwd 目录、settings/环境变量优先级、tmux 旧环境覆盖、空待命恢复、进入已停止会话不入队或重放旧任务、绝对路径绑定、身份检查、固定叶节点只读报告与旧布局保留 |
| 团队协作 | 轮流顺序、并行上限与轮间汇合、暂停/领取、原文分页、并发保存、mixed 隐私边界与未知结果 |
| 团队宿主接入 | Pi 1.5.0 的用户/custom 消息 before_agent_start、turn_end、原生 context 去重、子 reload 不重跑、窄通信工具与实例关闭 |

冒烟与 E2E 可分别运行 npm run test:smoke 和 npm run test:e2e。驱动直接提交工具输入，不生成模型响应。打包冒烟复用本地已安装依赖。

团队服务测试使用实际文件和结构化历史执行记录，不生成模型响应。Markdown 上下文与报告检查原文保真、嵌套代码围栏、渲染长度、续读位置、来源关联与分支去重；工具继续校验原有结构化 schema，不对提示词全文做快照断言。进程验收使用隔离的 Pi 认证目录与 tmux 服务，验证待命和无认证失败路径，不调用真实模型；这不等于完整多模型协作已通过验收。

0.2.0 的会话存储测试不调用模型。真实 CLI 观察扩展只记录会话身份、路径和原生模型状态；历史输入通过实际 SDK 保存。测试覆盖引用 I/O 失败阻断输入，以及缺失、空白、无效、错误身份/cwd 和非普通文件在 generation/入队变更前拒绝恢复。无认证环境只能验证不以初始模型选项覆盖原生恢复；保存模型的认证恢复成功仍需获准环境验收。

新增输入与通知检查使用真实本地附件和 Pi SDK：验证多附件来源、图片内容与原生截断续读，报告不可读时 status 仍可查询，工具拒绝缺项及跨 action 字段，以及故障通知进入模型上下文并遵循中断。通知回归使用真实控制锁与时间，检查暂停持续受阻后的延迟通知、去重和锁释放后的恢复；损坏的团队记录用于检查已通知的读取错误升级为需重载故障时再次通知，以及修复存储后仍须原生 reload 才恢复团队工具。这些检查不验证通知文案、真实模型的工具选择或提示优化效果。

Node 测试不下载第三方 Python 依赖；原生库集成验证见 [Python 说明](../python/README.md)。

## Pi 1.5 本地回归

开发依赖及全部 8 个 Pi 传递组件统一锁定 1.5.0。macOS、Node.js 24.22.2、npm 11.19.1 下，`npm run check`、`npm test` 和正常 prepack 打包通过；125 项测试全部通过，无跳过。补充 9 项包接入回归通过，实际资源加载检查扩展错误与包警告均为空。

全仓版本检查覆盖源码、测试、脚本、CI、资料、文档和锁文件。自有依赖与当前使用说明已统一到 Pi 1.5.0。固定版 dsh 的第三方 `dsh-llm-pi-ai` 仍声明 `pi-ai: ^1.3.0`，当前锁文件与安装树均解析到 1.5.0，没有旧版 Pi 副本；不改写第三方发布包的依赖范围。既有 Pi 1.1/1.4 验收记录保留原版本。

实际 tarball 在隔离消费者目录通过 `scripts/check-consumer.mjs` 验证：独立 CLI 无需 Pi/dsh SDK，显式安装 Pi 1.5.0 后扩展加载无错误或包警告，四个工具、技能和 `/pbot init` 均通过，不发起模型请求。

上述 Pi 1.5 本地批次未调用真实模型，也未重新执行 Linux、Node.js 22.19.0 或人工 TUI 验收。后续 CI 结果单独记录如下，不改写本地批次的范围。

## CI 与发布（2026-11-06）

以下记录限定为提交 `1625a78af324de412ba12b0689de6c9ebde61698`、`personal-bot@0.2.6`，Pi SDK 为 1.5.0，dsh 为 0.2.2-rc.1。

- [CI 运行 42242658306](https://github.com/realqiyan/personal-bot/actions/runs/42242658306)：Ubuntu、Node.js 24.22.2、npm 11.19.1 下，`npm ci --ignore-scripts`、`npm run check`、`npm test`、`git diff --check` 均通过。125 项测试全部通过，无失败或跳过；依赖边界为 135 个模块、554 条依赖。package 作业正常执行 `npm pack`，包括 prepack 的检查、CLI 构建和 dsh Host/Web 构建。
- 同次 CI 的 pi-consumer 作业使用 Node.js 22.19.0、npm 10.9.3，安装同一候选 tarball。独立 CLI 与显式安装 Pi 1.5.0 后的扩展加载、四个工具、技能、`/pbot init` 均通过，不调用模型。
- [发布运行 42242680832](https://github.com/realqiyan/personal-bot/actions/runs/42242680832)：同一提交的 OIDC 发布及 `Verify public version and latest` 成功。公开 npm registry 的只读核对确认 `personal-bot@0.2.6` 存在、`latest=0.2.6`，导出包含 `./lib/dsh.js` 与 `./lib/client.js`，dsh 元数据包含 Host/Web 所需的 bundle/client 声明。

这些结果补齐了该提交的 Linux 全量、Node.js 22.19.0 Pi/CLI 消费者和远端发布检查。独立消费者作业仅覆盖 Pi/CLI；dsh 本地 SDK 测试不代表候选包的包根 Web 加载及 Remote 传输已自动验收。下文保留此前 tarball 的 Web/桌面人工验证；公开版本和元数据核对不代表 0.2.6 已从 registry 完成全新 npx、Pi 或 dsh 安装，也不证明完整桌面模型流程。人工 TUI、成功模型调用、摘要取消和长运行缺口仍保留。

## 文档校正与安装来源回归（2026-11-07）

本次记录针对基于 `1625a78` 的文档校正及安装来源检查修复，不属于已发布 0.2.6 的验收记录。macOS、Node.js 24.22.2、npm 11.19.1 下，`npm run check`、`npm test`、`git diff --check` 与正常执行 prepack 的 `npm pack --dry-run --json` 均通过；127 项测试全部通过，无失败或跳过。

新增两项回归使用隔离的用户/项目配置、真实文件、子进程和 Pi SDK，检查缺失本地目录、未安装 Git 来源及无有效包名目录在计划前被拒绝，原配置保持不变；来源修复后能识别为保留项，独立单文件扩展与未安装 npm 声明仍可识别。测试没有执行联网安装或调用模型。本次改动未重新执行 Linux、Node.js 22.19.0、人工 TUI 或 dsh Web/桌面验收；前节 CI 结果仅适用于其记录的提交。

## dsh 命令与版本策略（2026-11-07）

当前源码的 dsh 安装示例改为 `latest`，`engines.dsh` 改为最低版本 `>=0.2.2-rc.1`，dsh SDK 保持 optional peer、范围为 `"*"`；开发依赖及解析版本仍为 0.2.2-rc.1。已同步中英文 README，并提供内容对应的[中文](dsh.md)和[英文](dsh.en.md)完整指南。已发布的 0.2.6 元数据没有被改写，本次范围放宽需后续发布才作用于 registry 安装。

npm 只读查询确认当时 `latest=0.2.2-rc.1`、Node.js 要求为 `>=24.9.0`。实际运行原生 CLI 版本与帮助，在临时 DSH_HOME、HOME 和工作目录创建独立 Web profile、导出配置及读取 Web 帮助；未启动个人 profile 或调用模型。插件命令参数对照原生转发实现与 pnpm 文档核对，本机 PATH 没有 pnpm，因此本轮没有实际安装、更新或移除 profile 插件。

使用真实 dsh `evaluatePluginCompatibility` 检查最低版本、后续版本和预发布版本字符串，并核对 package.json 与 shrinkwrap 的范围一致；这只验证范围语义，不代表那些后续版本的运行验收。macOS、Node.js 24.22.2、npm 11.19.1 下再次执行 `npm run check` 与 `npm test`，127/127 通过，无失败、取消或跳过，依赖边界为 135 个模块、554 条依赖。`git diff --check` 及正常执行 prepack 的 `npm pack --dry-run --json` 通过；267 个包条目包含两份 README、中英文 dsh 指南、Host/Web 产物和包/锁文件。

同日此前的全量复测还在已准备的用户级 Python 3.12.16 venv 中执行隔离模式的 `pip check` 与 `python/tests` 原生库测试，依赖检查和 5/5 测试通过；未安装或升级依赖。本轮文档和包声明修改后未重复计算库测试。Linux、Node.js 22.19.0、真实 Web/桌面插件安装及成功模型工作流的范围仍以上述既有记录为限。

## 模型上下文审查（2026-11-07）

本次针对基于 `1625a78` 的未发布工作区修改，覆盖 Pi/dsh 主会话、专家、团队任务及两种历史摘要入口，内容取舍与加载方式见[模型上下文](model-context.md)。macOS、Node.js 24.22.2、npm 11.19.1、Pi 1.5.0、dsh 0.2.2-rc.1 下，`npm run check`、`npm test`、`git diff --check` 均通过；135 项测试全部通过，无失败、取消或跳过，依赖边界为 137 个模块、558 条依赖。该总数包含当前工作区的安装与通知回归，不全是本次新增测试。

- Pi 使用真实资源加载器和 `_prepareRun` 观察认证前的主会话、专家首轮及后续差量，核对原生 AGENTS、用户职责补充、工具声明、技能目录、精简环境和条件性团队内容。主会话 no-skills、包级 `skills: []` 过滤均生效；未变化的 section 不追加，角色修改在下次准备时可见。新建 AGENTS 在原生 reload 后加载，已有内容保持原样。
- Pi 主会话与真实专家入口分别用不可读取的职责文件触发加载失败，实际 custom-message run 的原生 abort 信号已设置，未进入 provider 请求，tokens 为零。此处检查取消与调用时序，不以错误文案或唯一 stopReason 判断成功。
- dsh 使用真实 preset、Agent/Session 和原生文件/技能工具，核对专家 create/resume 的 preset 继承、首轮 AGENTS 和工具可见性、角色当次刷新、原文保真，以及项目/用户/包技能的优先级、文件更新监听和卸载生命周期。complete persona 保留宿主覆盖规则；noSkills 隐藏模型技能目录和工具，用户显式技能手势保留原生行为。
- dsh 团队首轮在实际 request/header 前收到共同目标、成员职责和公共原文；简报每次团队发言一次，公共序号按实际消费确认。回归覆盖无公共消息、准入拒绝后重新发言、后续批次去重及人工输入不追加团队内容。最终快照另保存主会话连续两次输入、普通专家、noSkills 专家和团队首轮；各请求在原生上下文组装后因缺少 provider adapter 失败，没有生成模型响应。
- 两个历史摘要入口通过源码核对：只提供专用提示与本次历史文本，不提供工具或普通会话上下文。现有历史测试继续验证分组、分页、持久化和并发；没有通过替代模型证明摘要质量。

首轮全量检查曾有一项真实 tmux/Pi 待命测试超时。隔离观察确认 Pi 联网元数据查询使子进程停留在 starting；在该离线 fixture 补齐其他原生进程测试已有的 `PI_OFFLINE=1` 后，单项与最终全量均通过。没有延长超时、修改生产启动规则或调整提示来迁就断言。

正常执行 prepack 的 `npm pack --dry-run --json` 通过，共 269 个包条目；包含 CLI、dsh Host/Web、team-member、compute-finance 和本文引用的上下文设计文档，已删除的 tool-guidelines 不再进入包。未发布。

证据目录：`/tmp/pbot-pi-context-audit-8UHhUu/` 保存 Pi 原始观察及最终六种加载场景；`/tmp/pbot-dsh-context-review-pn3D9O/` 保存修改前的 dsh 发现；`/var/folders/tg/_ll136tn58387kdsr5vxzzwr0000gn/T/pbot-dsh-final-context-3tSpqi/` 保存最终 dsh 原生请求和事件；`/var/folders/tg/_ll136tn58387kdsr5vxzzwr0000gn/T/pbot-context-review-RJEmho/` 保存修改前资源、Pi 汇总、待命诊断脚本及最终打包结果。临时文件可能被系统清理，行为回归保留在仓库测试中。

本次使用临时工作区及隔离的用户、认证和 Python 故障目录，不使用个人凭据，不修改用户资料、历史或备份。本地结果只证明上下文的来源、内容保真、出现时机及去重，不证明模型理解、专业判断、实际 token/费用或成功的外部服务工作流。没有重新验收 Linux、Node.js 22.19.0、完整 Web/桌面或成功模型调用；前述旧版本与已发布提交的验收范围保持不变。

## 模型指令通用提醒清理（2026-11-07）

在 `3d48fdd` 之后，清理公共提示、角色、团队消息、通知、工具说明及技能中的重复证据、权限和验收引导，保留目录用途、分页、配置作用域、计算方法与防重复执行说明；后续要求写入 AGENTS.md 及[模型指令编写原则](model-instruction-guidelines.md)。本轮不修改加载机制、状态规则或审批实现，不新增文案断言。

同一 macOS、Node.js 24.22.2、npm 11.19.1、Pi 1.5.0、dsh 0.2.2-rc.1 环境下，`npm run check`、`npm test`、`git diff --check` 通过；135/135 测试通过，无失败、取消或跳过，依赖边界仍为 137 个模块、558 条依赖。测试总数包含工作区已有的安装与通知回归。未调用真实模型；此前上下文快照对应上一轮措辞，本次通过现有行为回归检查加载、分页与通知，不将旧快照当作新文案实测。

## 0.2.7 本地候选检查（2026-11-07）

本次候选包含模型上下文与指令规则调整、Pi 安装来源检查、协作扫描恢复通知、dsh 最低版本与 optional peer 声明，以及中英文使用和设计文档。package.json、shrinkwrap 与两份 README 的当前版本同步为 0.2.7，子会话兼容线仍为 0.2。

macOS、Node.js 24.22.2、npm 11.19.1、Pi 1.5.0、dsh 0.2.2-rc.1 下，`npm run check`、`npm test`、`git diff --check` 全部通过；135/135 测试通过，无失败、取消或跳过，依赖边界为 137 个模块、558 条依赖。正常执行 prepack 的 `npm pack --dry-run --json` 通过，270 个包条目包含 CLI、dsh Host/Web、Pi 源码、提示与技能、编写原则和中英文 dsh 指南，不包含 dist 或 node_modules。此记录为本地候选检查，未执行本版本的远端 CI、npm 发布或真实模型验收。

## 双宿主接入验收

已完成 dsh 0.2.2-rc.1 基线的 Host/Web、专家与团队、附件、通知、双来源 history 和人工管理。当前结果与证据位置持续记录在[实施记录](dsh-implementation-plan.md)，使用入口见[dsh 使用](dsh.md)。

- Pi 1.5 本地回归在 macOS、Node.js 24.22.2、npm 11.19.1 下完成 `npm run check`、`npm test`、`git diff --check`，125/125 通过，无跳过；依赖边界为 135 个模块、554 条依赖。正常 `npm pack --dry-run` 与 prepack 打包通过。2026-11-06 对提交 `1625a78` 的 Linux 全量检查也已通过，见上节 CI 记录。
- 正常 tarball 在独立消费者目录安装后没有安装 Pi/dsh SDK 副本；Node.js 22.19.0 下独立 CLI 返回版本，Pi 实际加载四个工具与技能、执行资料初始化和空专家查询通过。固定版 dsh 原生安装最终运行代码后，完整 Web 流程再次通过。
- 正常执行 prepack 的 tarball 经原生插件命令安装后，真实 Chrome 验证四个 Remote、资料准备、文件与图片上传、长原生记录分页、私人草稿、公共消息分页、停止后冷读、显式恢复、history 查询与页面刷新。缺 provider 的批次真实失败并暂停，没有生成模拟响应。
- 原生 Web 审批验证单次允许、真实取消以及等待期间符号链接变化；使用原生 Session 审计和真实 write 工具，不生成模型响应。
- 原生 Web 停用插件后入口移除，专家释放；重新启用后专家保持停止且记录可冷读。单独关闭管理页不停止已接纳专家。关闭整个浏览器进程后重新连接，父身份与两个专家的存活状态保持。长断线及真实模型运行中的接管、取消仍需后续验证。
- SDK 资源检查验证包内及工作区技能发现、不同工作区目录隔离、实际 skill 工具读取、noSkills 与专家工具限制。它证明原生可见性与加载，不证明模型会正确选用方法。

Python 测试已同时隔离 HOME 与 XDG_DATA_HOME，并用真实准备脚本确认目标目录。首轮 macOS 全量前的 fixture 隔离不完整；随后对个人 Python 目录的元数据核查未发现该轮开始后修改的文件或目录条目。没有删除、回滚或覆盖个人环境，不能追溯声称首轮从未访问它。临时损坏环境只验证失败与恢复路径，不代表依赖成功安装。

尚无本次获准的真实提供方工作流。成功专家/团队协作、通知后的模型推进、后台摘要成功及真实请求取消均未验收；旧版 Pi 模型冒烟和缺 provider 失败路径不能替代这些结果。

### macOS 桌面应用实测

使用本机 `/Applications/DeepSeek Harness.app` 0.2.2-rc.1、自带 Node.js 24.21.0，另开隔离的 Electron userData、DSH_HOME、HOME 与 Documents 工作区；原有应用进程持续运行。通过应用原生“插件 → 添加插件”安装实际 tarball 并启用，没有使用 dsh CLI 安装该测试 profile。

- 四页签与资料准备、524,305 字节文件及 1×1 图片上传、完整 JSON 分页重组、草稿保留、20,000 字符公共消息分页、团队真实缺 provider 后暂停、停止后冷读、携新要求恢复、history 查询及 Renderer 刷新全部通过。观察到 10 次管理写命令，轮询和刷新没有增加写命令，页面错误为空。
- 32 MiB 上传开始后立即关闭管理页，上传取消且没有提交 chat 命令或追加 inbox 消息；已创建专家继续存活。完整退出应用后再启动，两个专家保持停止且原生记录保留；插件停用、重新启用同样不自动恢复。
- 临时登录 Shell 的 PATH 配置为真实 Python 3.12 后，应用自动创建独立 venv 并安装锁定依赖，状态达到 ready。该环境 `pip check` 成功，5 项 Python 原生库测试通过，覆盖 TA-Lib/backtesting、统计与 sklearn、Excel/Parquet/Feather 往返及绘图。这证明本机桌面准备和库配合，不证明模型能正确开展研究。
- 隔离实例的原生模型选择器显示 `No models available`，未配置认证，没有进行成功模型调用。

证据位于 `/tmp/pbot-dsh-desktop-test/`：`smoke.json`、`verified.json`、`lifecycle.json`、`python.json`、`python-library-tests.log`、`model-picker.txt` 与对应截图；脚本位于 `/tmp/pbot-dsh-browser/desktop-*.mjs`。临时文件可能被系统清理，测试应用进程已退出，资料与记录保留。

### 界面验收

- Pi 1.4.0 真实终端通过 `/pbot` 菜单、只读状态页、历史入口和窗口缩放验证。真实组件测试覆盖长列表、中文／emoji 换行、滚动及深浅主题。
- 桌面应用通过原生插件页安装最终 tarball。专家切换保留各自草稿与附件；轮询保留表单焦点和分页。文件／图片、完整事件分页、团队消息、history、停止／恢复及刷新通过，8 次写命令，页面错误为空。
- 原生设置切换浅色／深色后，四页在 1360、560、360 像素宽度均无横向溢出；主按钮文字对比检查通过。

证据位于 `/tmp/pbot-ui-review/`，包括 `check.log`、`pi.json`、`gui.json`、`themes.json` 与截图。此轮未执行成功模型工作流。

## 安装器验收（2026-11-03）

本次实现完成以下验证。安装验收使用临时工作区与独立的用户目录、npm cache/prefix，不使用个人凭据或模型请求：

- Linux、Node 24.15.0、npm 11.19.1、Pi SDK 1.4.0：`npm ci --ignore-scripts`、`npm run check`、`npm test` 全部通过，99 项测试无跳过；`npm pack --dry-run` 通过。
- macOS、Node 24.22.2、npm 11.19.1：17 项安装测试通过；实际 tarball 的全局安装与 npm exec 均可执行 `pbot --version`，两种安装都未下载 Pi SDK。现有 Pi 1.5.0 managed launcher 与实际安装根目录的识别通过。
- Linux 真实终端：从无 Pi 的独立 prefix 安装 Pi 1.5.0，再通过 Pi 安装 registry 的 pbot 0.2.3；重复运行、原生项目信任确认和不启动 Pi 的选择均成功。另将临时 Pi 安装为 1.4.0，确认 setup 通过原生 `pi update` 升级至 1.5.0。工作区仅有 `npm:personal-bot@latest` 声明，未选插件未安装，未直接创建 AGENTS.md。
- 全局 npm 资源过滤的真实终端验收：工作区声明继承 `extensions: []` 和 `skills: []`，全局配置原文未变化，未启用被禁用的资源。
- 本次打包的 pbot 与 Pi 1.5.0 SDK 完成 `/pbot init` 分发，创建资料且不调用模型；没有 pbot 时，保护扩展拦截未分发输入。共享 Python 环境使用真实的不可用临时目录，验证失败提示和资料初始化的独立性，不作为 Python 依赖安装成功的证据。
- 系统 Python 缺少 ensurepip 时，真实 CLI 在安装软件前退出。正向终端验收使用已存在的 Python 3.13.13，没有更改系统 Python。服务器原有 npm 12.0.2 的 `npm ci` 未接受仓库 shrinkwrap，本次仓库回归使用临时安装的 npm 11.19.1，未更换服务器 npm。

仍需验收 Homebrew/各 Linux 包管理器的提权与 tmux 实际安装、macOS 完整安装交互、Pi TUI 登录及模型选择、配套插件的外部服务与模型调用。同一工作区不应并发运行多个安装器；各原生包管理器不提供跨组件事务。全局 Git/本地来源与工作区 npm 来源发生身份冲突时，安装器保留现状并要求先用 Pi 原生配置调整加载范围，不自动移除全局来源。

## 已批准的真实模型冒烟（0.1.3）

2026-10-28 在 Linux、Node.js 24.15.0、tmux 3.3a、Pi 1.1.0 下验收当时的 0.1.3 源码。0.2.0 改用原生会话位置及开发依赖升级至 Pi 1.4.0 后均未追加真实模型冒烟，以下结果不作为新布局或新宿主版本的模型验收。主会话与两个独立子进程均使用 openai-codex/gpt-6-astra、low 思考级别；复用同一对成员，roundRobin 和 parallel 各运行一轮。这是同型号多 agent 验收，不是异构模型组合验收。

| 项目 | 实测结果 |
| --- | --- |
| 无任务 start | 两个成员进入 idle，没有模型响应或初始请求 |
| 普通 post | 不唤醒主模型 |
| roundRobin | 32.8 秒完成两个请求；B 在 A 结束后启动，逐字引用 A 的公开 JSON，核验 17+25=42；B 的原生 custom context 保存了 A 的原文 |
| parallel | 23.9 秒完成两个请求；两周期重叠约 21.8 秒，双方的最终答复均逐字引用了对方的 post |
| 自动公开 | 四份公共最终答复与对应原生固定叶节点报告完全相同 |
| 主通知 | 主模型没有在成员工作期间运行；每批结束后自动恢复一次工作周期，只调用 status/read，没有个人完成通知重复投递 |
| 关闭与退出 | close 保留两个 idle 成员；主会话退出后无存活子进程，独立 tmux 服务已清理，临时认证已删除 |

无扩展错误，未修改运行代码。原生记录共计 18 条模型响应（含工具调用响应），usage 合计 input=30272、cacheRead=52608、output=1075。Pi 目录价估算约 0.4091 美元，不代表 OAuth 订阅的实际账单。

证据保存在临时目录 `/tmp/pbot-live-smoke-icSpOD/`：`result.json` 是结果与用量摘要，`run.log` 是阶段日志，`config/pbot/teams/` 与 `config/pbot/subagents/` 保存团队记录和原生会话。临时目录可能被系统清理，本节保留验收摘要；认证文件不保留在证据中或仓库内。

本轮只发送人工生成的通信数据，不加载 MCP，不向模型开放文件或 Shell 工具，不使用交易凭据。为避免改动共享 Python 环境，用隔离的占位路径使准备步骤报告未就绪；Python 不是本轮验收对象。工具选择和临时目录不构成宿主沙箱。

## 剩余外部验收

以下行为仍需获准环境验收，不能从上述单轮冒烟或本地测试推导：

| 范围 | 验收重点 |
| --- | --- |
| 历史摘要 | 真实模型的摘要质量、递归汇总后按大意回溯、取消与恢复的实际模型请求、长会话扫描性能及人工浏览 |
| 真实模型与专家 | 0.2.0 原生会话存储下的委派交付与认证模型恢复、运行中 steer/follow-up、独立复核、通知推进和实际用量 |
| 真实模型团队 | 异构模型组合、三人及多轮讨论、并行轮间互相引用、自动重试/恢复、人工 mixed 输入、团队/私人工作切换、长时间运行及实际账单 |
| Task Conductor | 实际多节点产物、至少两轮周期任务、Pi 关闭或重载后的查询与防重复提交 |
| CLI/MCP | 认证、发现、重连、动态工具、取消与业务结果 |
| TUI/RPC | 人工 attach、焦点、批准、查看器、长时间运行和会话导航 |
| npm 分发 | 0.2.6 从公开 registry 全新安装的 npx 入口、Pi 与 dsh 原生安装及 Host/Web/Remote 检查、用户环境反馈；该版本 OIDC 发布与公开版本/latest 查询已于 2026-11-06 完成 |
| 平台与存储 | macOS 独立安装器的完整交互、断电持久性及文件系统差异；提交 `1625a78` 的 Linux 全量检查已于 2026-11-06 完成 |

研究与资料方法使用真实任务资料验收，重点检查来源追溯、口径一致、缺失数据处理、历史前提复核、产物引用和结项依据。知识沉淀需检查是否提炼方法与口径，以及后续任务能否据此重新取数。探索任务应区分实验失败与假设被否定。

记录验收环境、实际结果、证据位置与剩余缺口。连接可用、资源可见或格式正确只证明相应技术环节，不代表模型完成了业务任务。
