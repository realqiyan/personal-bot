# npm 发布与验收

发布配置以 `package.json` 为准：包名 `personal-bot`，registry 为 npmjs，稳定版本使用 `latest`。发布包包含 Pi 扩展源码、共享资源、独立 CLI（`setup` / `install-antigravity` / `mcp`）、dsh Host/Web、Claude 插件、自包含 `lib/antigravity-plugin/` 以及独立打包的 `lib/extension/{mcp,acp-worker}.js`。

## 首次配置

| 位置 | 配置 |
| --- | --- |
| npm | 确认包名与发布账号权限 |
| GitHub Environment | 创建 `npm`，配置审核人，部署来源限制为 `v*` tag |
| GitHub ruleset | 限制发布 tag 的创建、修改和删除 |
| npm Trusted Publisher | 绑定 GitHub owner/repository、`publish.yml` 与 Environment `npm`（OIDC，无需保存 `NPM_TOKEN`） |

## 准备候选包

在 Linux + Node.js 24.9+ 准备候选包（消费者最低基线：Pi/CLI/轻插件/MCP 为 Node.js 22.19+、Claude CLI 2.1.325+、Antigravity `agy` 1.5+；dsh 为 Node.js 24.9+、dsh 0.2.2-rc.1+）：

```bash
npm version <新版本> --no-git-tag-version --ignore-scripts
npm ci --ignore-scripts
npm run check
npm test
agy plugin validate --strict ./lib/antigravity-plugin --json
claude plugin validate --json ./.claude-plugin/plugin.json
git diff --check
npm pack --dry-run
npm pack
```

同步更新 `README.md` 与 `README.zh-CN.md` 的版本号，并按[维护脚本](../../scripts/README.md)对实际生成的 tarball 执行 `check-consumer.mjs`、`check-dsh-consumer.mjs`、`check-claude-consumer.mjs` 消费检查。`npm-shrinkwrap.json` 仅用于开发与 CI，不进入发布包。

## 发布流程

### GitHub OIDC 发布（推荐）

推送到默认分支并通过 CI 后打 tag 触发 [publish.yml](../../.github/workflows/publish.yml)：

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

### 本机发布

```bash
npm whoami --registry=https://registry.npmjs.org
VERSION=$(node -p "require('./package.json').version")
npm publish "./personal-bot-$VERSION.tgz" --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org
```

## 发布后验收

1. 核对公开版本：`npm view personal-bot dist-tags --json --registry=https://registry.npmjs.org`。
2. Pi 消费检查：`node scripts/check-consumer.mjs npm:personal-bot@<version>`。
3. dsh：在独立 profile 安装 `personal-bot@latest`，核对 `/pbot status`、Web 工作区/历史页与 `mcp__pbot__worker_*`。
4. Claude Code：通过 `/plugin install personal-bot --marketplace realqiyan/personal-bot` 安装，核对版本、`/personal-bot:pbot status` 与 `worker_*` MCP。
5. Antigravity：通过 `npx personal-bot@latest install-antigravity` 安装，核对 `/pbot status` 与 `worker_*` MCP。
6. 真实模型环境下各宿主首轮上下文、技能选择与跨 Harness 实测调用（含 `npm run test:e2e:acp`）在独立批准环境单独验收。
