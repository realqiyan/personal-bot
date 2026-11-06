# dsh 使用说明

Personal Bot 的 dsh 接入固定为 `@deepseek-ai/dsh@0.2.2-rc.1`，首个界面是原生 Web。它与 Pi 共用资料、角色、方法、Python 环境及协作规则，分别使用各自的原生会话、模型配置和认证。

当前代码已接入专家、团队、历史查询和管理界面。实际通过的检查与尚未完成的真实模型、Linux 验收见[实施记录](dsh-implementation-plan.md)和[验证](validation.md)；预发布宿主的接口可能变化，不应直接换成其他版本。

## 在桌面应用中验证

本机检查的 `DeepSeek Harness.app` 为 `0.2.2-rc.1`，其内置运行时使用 Web 基础插件与独立的 `desktop` profile。可以从应用的“插件 → 添加插件”输入本地 `.tgz` 安装包的绝对路径安装，再启用 personal-bot；不必另行安装或启动 dsh CLI。请使用本次源码构建的包，既有 npm 发布版不包含本次未发布改动。

安装后选择一个测试工作区和主会话，输入 `/pbot` 并选择管理入口，应看到工作区、专家、团队、历史四个页签。先验证状态、资料准备和无任务专家，再通过应用原生设置选择模型，验证附件、实际专家回答及一轮团队协作。历史摘要可在至少四次正常完成的主会话问答后检查。

已在 macOS 的实际桌面应用 `0.2.2-rc.1` 中通过原生插件页面安装、启用，并验证四个管理页签、附件、完整记录、团队失败暂停、history 查询与界面刷新。应用自带 Node.js 24.21.0；隔离环境中的 Python 锁定依赖安装及 5 项原生库集成测试也通过。成功模型回答、协作与摘要仍需有可用模型的环境，详见[验证记录](validation.md)。

关闭管理面板只关闭视图，并取消尚未接纳的上传；已接纳专家保持存活。此次实测完全退出桌面应用会关闭后端并停止专家，重开后保留记录且不自动恢复。停用再启用插件具有相同的显式恢复要求。CLI 的独立 `pbot` profile 与应用的 `desktop` profile 分开，不会因为已在 CLI 测试 profile 安装而自动出现在应用中。

## 安装与启动（CLI + 浏览器）

Pi 消费路径和独立 `pbot` CLI 保留 Node.js 22.19+；dsh、双宿主开发和完整验收使用 Node.js 24.9+，目标验收环境为 Linux。计算使用 Python 3.11+。桌面应用会读取登录 Shell 环境，应确保所需 Python 在该环境的 PATH 中可见；终端进程的 PATH 不一定就是应用后端最终使用的 PATH。`pbot setup` 仍是 Pi 安装器，dsh 使用自己的插件与 profile 流程。

下面从当前源码生成安装包，不依赖 npm 上的既有版本已经包含 dsh 接入：

```bash
npm ci --ignore-scripts
npm pack
npm install -g @deepseek-ai/dsh@0.2.2-rc.1 pnpm@10.20.0
```

仅在第一次创建独立的 `pbot` profile 时运行：

```bash
dsh --profile pbot --from-default-profile web --dump-config
```

将下面的 tarball 路径换成实际构建产物，再安装并启动：

```bash
dsh plugin --profile pbot add /absolute/path/to/personal-bot-<version>.tgz
dsh --profile pbot
```

更新包仍使用原生插件命令，不再执行 `--from-default-profile`，以免重建已有 profile。模型、认证、插件和 MCP 由该 profile 的原生设置管理；pbot 不复制 Pi 配置，也不接管 Pi 会话。安装和打开页面不启动模型任务。

在 Web 中选择工作区，再打开主会话。一个 profile 可以管理多个工作区。pbot 绑定主会话建立时的根目录；之后改变原生工作目录只影响相对路径解析，不改变资料、历史与文件规则的根目录。

固定版默认工作区使用宿主账户的系统 Documents 目录。需要指定目录时使用原生工作区选择器；测试部署可在原生 `workspace-controller` 配置中设置 `documentsDirectory`。只设置 `HOME` 或改变启动 cwd 不等于改变系统 Documents 策略。

## 管理入口

在原生输入框选择不带参数的 `/pbot`，打开四个页签：

| 页签 | 操作 |
| --- | --- |
| 工作区 | 查看来源、目录、模型、Python 和历史整理状态；准备资料或重试 Python |
| 专家 | 创建、重命名、停止、显式恢复；人工对话、附件和完整原生记录 |
| 团队 | 固定成员与职责、有限轮次、暂停、关闭、公共原文和长消息分页 |
| 历史 | 按 Pi/dsh 来源与时间查询，读取问答及摘要，沿父子节点导航 |

宽窗口使用侧边导航，窄窗口使用顶部导航。专家可按名称或状态筛选；高级设置和原生事件按需展开。草稿与附件按专家保留，团队草稿分别保留。

`/pbot init` 只补建缺失的资料目录和根 `AGENTS.md`。已有资料保持不变；没有工作区启用文件，也不要求初始化后才能使用。

页面查询通过原生 Remote；它不会启动专家、接管旧执行实例、领取模型通知或生成摘要。原生命令本身保留宿主审计记录。轮询保留当前表单草稿与长记录页；关闭、刷新或切换页面不停止已经接纳的工作。连接中断导致操作结果不明确时，先重新查看状态与记录，再决定后续动作。

## 专家与附件

省略初始任务与附件时，只创建待命专家。每个父会话最多 50 个存活或正在启动、释放的专家。dsh 专家是同进程中的独立原生 Agent/Session，无需 tmux，也不继承父聊天历史。

模型默认继承父会话的原生选择。`thinking` 使用 dsh 的 reasoning effort ID；改变 provider 或 model 时，不自动带入另一模型的 effort。`tools` 使用当前原生工具名称，`noSkills` 关闭模型技能目录和 skill 工具，用户显式技能命令仍按宿主处理；Pi 专属的 `noExtensions`、`noPromptTemplates`、`noContextFiles` 明确拒绝。

专家创建和恢复时应用父会话的原生 preset，保留其文件工具、AGENTS 和技能发现，再应用专家工具限制。包内技能由 Host 提供，项目和用户技能沿用原生优先级与更新监听。显式使用 complete persona 时，宿主可能覆盖 pbot 的公共约定与角色；选择这种 persona 时需自行维护完整行为要求，详见[模型上下文](model-context.md)。

初始任务可以指定服务器文件路径。人工对话还可从本机选择文件与图片，单次最多 32 个附件；一次选择服务器路径或本机附件。通用文件使用原生上传与持久文件引用，PNG/JPEG/WebP/GIF 图片接受原生图像准入，数量和字节上限由宿主控制。路径不是“模型已经读过文件”的证据。

人工对话先暂停所属团队，再通过原生 steer 或 follow-up 进入专家。暂停失败时不接纳私人输入。人工输入与团队输入混合的周期不会自动公开；已经显式发布的公共消息保留。共享专家上下文不是保密隔离，需要独立背景时创建新专家。

原生记录按事件分页，正文与原始 JSON 都可继续读取长内容。停止后仍能冷读记录；恢复必须给出新任务，不重放旧 inbox。工具结果、错误与审批记录保留在原生会话中，history 不能代替这些记录。

## 团队和生命周期

团队仍使用 `pbot_team` 与 `pbot_team_message`：固定成员、roundRobin 或 parallel、有界轮数、并发上限与期限。成员就绪只表示接入可用，不证明模型认证或业务能力。普通公共发言不唤醒模型；正常完成的纯团队答复才自动公开。完整规则见[专家协作](agent-collaboration.md)。

服务端资源决定执行生命周期。关闭或卸载 pbot 组件、释放所属父 Agent 会暂停安排并释放它拥有的专家；重新打开页面或加载组件只读取记录，需要明确恢复才继续工作。浏览器关闭与服务端父 Agent 释放是不同事件。

主会话修改原工作区外文件时，通过原生审批请求一次允许。专家的原生 write、edit、apply_patch 不允许修改原工作区外文件；整份 patch 在执行前检查源和移动目标，并在确认后复核路径身份。这些规则不隔离 Bash、Python、MCP 或其他扩展。

## 命令与模型工具

带参数时 `/pbot` 使用原生命令执行；管理页写操作与这些命令共用服务：

```text
/pbot status
/pbot init
/pbot python setup
/pbot agent {"action":"start","name":"核对专家"}
/pbot chat {"agentId":"…","text":"核对这些资料","delivery":"steer"}
/pbot team {"action":"list"}
/pbot post {"teamId":"…","text":"向全体成员公开的信息"}
/pbot history {"action":"search","host":"dsh","query":"研究口径"}
/pbot records {"agentId":"…"}
```

模型使用 `pbot_agent`、`pbot_team`、`pbot_team_message`、`pbot_history`。参数按本宿主契约校验，不把 Pi 参数改名后继续传给 dsh。原生 CLI/MCP 的可用性与用户授权、实际执行成功分别判断。

Pi 维护 `.pi/pbot/history/`，dsh 维护 `.dsh/pbot/history/`。两者共同查询已有归档，只更新和整理自己的来源。查询不调用模型；正常主交互结束后的空闲阶段才使用该宿主当前模型补齐摘要，新人工输入优先取消整理。详见[历史对话](history.md)。
