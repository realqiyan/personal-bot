# 维护脚本

## 构建

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 清理 dist，编译测试模块，再依次构建 CLI、dsh 和 Claude |
| `npm run build:cli` | 清理 lib，编译独立安装器、Pi 检查桥接与启动保护 |
| `npm run build:dsh` | 编译 Host，将 TypeBox 与许可证纳入 lib，再构建原生 Web Loader 模块 |
| `npm run build:claude` | 编译 Claude Node hook/CLI 入口，从共享职责生成原生 Markdown agent，同步插件及 marketplace 版本 |

完整构建和 prepack 均按 **CLI → dsh → Claude** 执行；build:cli 会清空 lib，单独重建它后也须补齐后两项。Claude 构建只用 tsc 编译 Node 入口并生成原生资源，不生成 mod、类型快照或 MCP 桥接。宿主 SDK 保持 external，Pi 直接加载 src。完整开发与验收使用 Linux、Node.js 24.9+，Pi/CLI/Claude Node 消费者最低 Node.js 22.19；Claude Code 当前验证基线为 2.1.325。

## 安装包检查

先 `npm pack`，使用生成的实际 tarball 检查交付路径；`npm pack --dry-run` 仅用于查看清单。完整开发 npm-shrinkwrap.json 留在仓库，不进入发布包；消费者按正常运行依赖安装。

| 命令 | 检查内容 | 环境 |
| --- | --- | --- |
| `node scripts/check-consumer.mjs <tarball>` | 独立 CLI、Pi 扩展、技能、工具与资料初始化；安装 Pi 前核对消费根和包内均未安装宿主依赖 | CI 使用 Node.js 22.19.0，脚本安装锁定的 Pi SDK |
| `node scripts/check-dsh-consumer.mjs <tarball>` | dsh 原生插件安装、独立 CLI 与 Host 导入；检查无需单独安装 TypeBox 或宿主 SDK | Node.js 24.9+、仓库开发依赖和 PATH 中的 pnpm |
| `node scripts/check-claude-consumer.mjs <tarball>` | 实际 tarball 安装与原生 plugin validate；另在直接解包且没有 node_modules 的目录执行 hook、CLI 和资料读取 | Node.js 22.19+、Claude Code 2.1.325+；PBOT_CLAUDE_COMMAND 可指定 CLI |

上述脚本使用隔离用户目录、宿主配置与工作目录，结束后清理临时目录，不调用模型。Pi 检查扩展加载与资料初始化，dsh 通过原生 schema 收集导入 Host。Claude 在独立 npm 消费目录安装实际 tarball，核对版本、原生资源与 hook 参数；再从直接解包目录运行未启用工作区的 hook/status，以及已启用工作区的专家资料读取，覆盖原生 marketplace 不安装 npm 依赖的缓存目录。不访问日常会话或凭据。

Claude 包内路径包括 `.claude-plugin/plugin.json`、marketplace、`hooks/hooks.json`、`lib/claude.js`、`resources/claude/skills/pbot/SKILL.md`、原生 Markdown agent、共享资料与工作方法技能。`resources/skills/.claude-plugin/plugin.json` 保留给 Pi/dsh 的 Claude ACP 目标。可对实际安装包执行原生校验：

```sh
claude plugin validate /absolute/path/to/installed/package/.claude-plugin/plugin.json
```

消费环境不依赖仓库 cwd、dist 或开发 node_modules。发布后运行 `node scripts/check-consumer.mjs npm:personal-bot@<version>`，通过公开 registry 按包名安装再执行相同检查；分别记录实际 Node/npm 版本，不能用本地 tarball 安装代替这条路径。只有实际执行的项目才记录为通过，版本与未执行项写在任务、PR 或 CI。

## 本地 Node hook 检查

默认 `npm test` 保留 Pi/dsh 测试，并包含 `tests/claude/` 的纯 Node hook 进程检查。已构建后可用 `node --test --test-concurrency=1 tests/claude/*.test.mjs` 单独运行。这些检查使用临时工作区和隔离用户目录，验证标准 hook 输入输出、固定工作区根、启用配置、技能准入、资料保留与 CLI 行为，不发送模型请求，也不加载旧 mod 生命周期。

## 原生模型验证

Claude 的实际首任务上下文、`/personal-bot:pbot` 技能调用、工作方法技能与 `personal-bot:general-purpose` 专家加载需要在明确批准的原生模型环境验证。使用专用认证、隔离配置与临时工作区，不使用个人凭据。原生团队开关与 teammate mode 由运行者管理，团队会话及恢复遵循 Claude 原生规则。标准插件验证范围见[Claude 接入设计](../docs/claude-code-design.md)。默认 Node 测试与 plugin validate 不调用模型，当前尚未完成这些原生模型验证。

## ACP 真实模型 E2E

在明确批准、单独准备 Pi/dsh/Claude 模型与测试认证的环境执行 `npm run test:e2e:acp`。该命令在临时工作区调用三个真实后端，省略 model、thinking 和 provider 验证默认值；另测 Claude 显式 low 覆盖原生环境 max。检查文件结果、报告分页、停止耗时，并对照 Claude 原生请求中的模型与思考等级。它单独运行，不进入 `npm test`，属于 Pi/dsh 的 ACP 目标验证。

入口默认从 PATH 查找。可用 `PBOT_ACP_E2E_PI_COMMAND`、`PBOT_ACP_E2E_DSH_COMMAND`、`PBOT_ACP_E2E_CLAUDE_COMMAND` 指定已有可执行文件路径；dsh 仍使用 acp profile。`PBOT_ACP_E2E_OUTPUT_DIR` 指定输出目录，默认使用临时目录；每个工作区保留 input.json、output.json、report.txt 和 result.json；Claude 用例还保留仅含模型与等级的 native-requests.json。
