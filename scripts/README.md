# 维护脚本

## 构建

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 清理 `dist`，编译测试模块，再依次构建 CLI、dsh 与插件产物 |
| `npm run build:cli` | 清理 `lib`，编译独立 CLI（`setup` / `install-antigravity` / `mcp`）、Pi 检查桥接与启动保护 |
| `npm run build:dsh` | 编译 Host，将 TypeBox 与许可证纳入 `lib`，再构建原生 Web Loader 模块 |
| `npm run build:plugins`（`build:claude` 别名） | 编译共享插件运行时（`lib/plugin.js`、`lib/claude.js`），通过 `esbuild` 打包零外部依赖的 `lib/extension/mcp.js` 与 `lib/extension/acp-worker.js`，并执行各已注册插件宿主构建目标（同步 Claude 清单、组装自包含 `lib/antigravity-plugin/`） |

完整构建与 `prepack` 均按 **CLI → dsh → plugins** 顺序执行；`build:cli` 会清空 `lib`，单独重建它后须补齐后两项。宿主 SDK 保持 optional peer，Pi 直接加载 `src`。完整开发使用 Linux/macOS、Node.js 24.9+；Pi/CLI/轻插件与打包 MCP/ACP 入口支持 Node.js 22.19+（Claude CLI 2.1.325+，Antigravity `agy` 1.5+）。

## 插件校验与安装包检查

先 `npm pack`，使用生成的实际 tarball 检查交付路径；开发用 `npm-shrinkwrap.json` 不进入发布包。

| 命令 | 检查内容 |
| --- | --- |
| `agy plugin validate --strict ./lib/antigravity-plugin --json` | 按 Antigravity 原生加载器严格校验 `plugin.json`、`hooks.json`、`mcp_config.json` 与 `skills/` |
| `claude plugin validate --json ./.claude-plugin/plugin.json` | 校验 Claude 插件清单、hooks、`.mcp.json` 与技能 |
| `node scripts/check-consumer.mjs <tarball>` | 独立 CLI、Pi 扩展、技能、工具与资料初始化（确认不连带安装宿主 SDK） |
| `node scripts/check-dsh-consumer.mjs <tarball>` | dsh 原生插件安装、独立 CLI 与 Host 导入 |
| `node scripts/check-claude-consumer.mjs <tarball>` | 实际 tarball 安装与原生校验；在无 `node_modules` 的解包目录执行 hook、CLI 与资料读取 |

## 本地测试与真实模型验收

- `npm test` 运行全量本地测试，覆盖 `PluginHostRegistry` 与 `AcpHarnessRegistry` 动态扩展、隔离无 `node_modules` 的 Claude/Antigravity hooks 与 MCP `pbot_worker` → ACP v1 真实进程互调，以及 Pi/dsh 原生 MCP 挂载、历史与 E2E 测试。
- 真实模型环境下各宿主的首次上下文、技能选择与跨宿主实测调用（含 `npm run test:e2e:acp`）在明确批准且不含个人凭据的专用环境单独验收。
