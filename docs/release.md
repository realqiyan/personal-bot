# npm 发布

发布配置以 package.json 为准：包名 personal-bot，registry 为 npmjs，稳定版本使用 latest。包包含 Pi 扩展源码、共享资源、预构建的安装 CLI 和 dsh Host/Web 产物。Pi 加载源码入口，dsh 通过原生包根 Loader 加载 Host 与 Web 客户端；npx 与全局 pbot 命令由 Node 直接运行。

## 首次配置

发布前完成以下配置：

| 位置 | 配置 |
| --- | --- |
| npm | 确认包名与发布账号权限 |
| package.json | 补充许可证、对应许可文件及实际 repository 地址 |
| GitHub 仓库 | 确认默认分支；ci.yml 默认监听 main/master |
| GitHub Environment | 创建 npm，配置审核人，部署来源限制为 v* tag |
| GitHub ruleset | 限制发布 tag 的创建、修改和删除 |
| npm Trusted Publisher | 填入实际 GitHub owner/repository、publish.yml 和 Environment npm |

Trusted Publisher 使用 GitHub OIDC，无需保存 NPM_TOKEN。首次包创建与授权条件见 [npm 官方说明](https://docs.npmjs.com/trusted-publishers/)。需要先创建包时，由维护者完成首次本机发布，再配置 Trusted Publisher。

provenance 所用 repository 元数据须与实际公开仓库匹配。若改为 scoped 包名，同步修改包与锁文件、工作流中的包名和 tarball 名、安装说明。第三方 Python 库许可见 [Python 说明](../python/README.md)。

## 准备候选包

使用 Linux、Node.js 24.9+ 和 Python 3.11+ 准备发布包。Pi 与独立 CLI 的消费者检查仍使用 Node.js 22.19.0。更新版本：

```bash
npm version <新版本> --no-git-tag-version --ignore-scripts
```

同步 `README.md`（默认英文）和 `README.zh-CN.md` 的版本与使用说明，执行：

```bash
npm ci --ignore-scripts
npm run check
npm test
git diff --check
npm pack --dry-run
npm pack
```

prepack 依次执行 `npm run check`、`npm run build:cli`、`npm run build:dsh`。核对包清单包含 bin、lib（含 dsh Host/Web 产物）、src、resources（含 dsh bundle patch）、Python 锁文件、setup 脚本和 npm-shrinkwrap.json，排除 dist、node_modules、凭据与运行数据。核对包根与 `./dsh` 导出指向 `./lib/dsh.js`、`./client` 指向 `./lib/client.js`，以及 dsh bundle/client 元数据完整。

Pi/dsh 宿主包保持 optional peerDependencies，避免独立 CLI 安装时隐式下载宿主 SDK。dsh SDK peer 范围为 `"*"`，最低宿主要求由 `engines.dsh` 声明；用户安装跟随 `latest`，开发依赖及锁文件保留精确版本。发布验收记录实际 dsh/pnpm 版本，不把最低版本声明视为未来版本已验收。共享契约库 TypeBox 是范围为 `"*"` 的必需 peer，开发依赖锁定版本；Pi 原生加载器提供它，dsh 安装时由包管理器补齐。另在独立 npm cache/prefix 中验证 tarball 的 npm exec 与全局 pbot --version，检查未额外安装 Pi/dsh SDK。

在独立 Pi 配置和临时工作区验收安装；加载扩展会准备用户级 Python 环境，因此验收同时使用独立用户数据目录。再按[dsh 使用说明](dsh.md)，在当前 dsh `latest` 的隔离 Web profile 中通过原生插件命令安装同一 tarball，并记录实际宿主版本，核对 Host 启用、包根 Web 客户端加载、`/pbot` 四页签及原生 Remote 查询。验证范围与剩余缺口见[验证](validation.md)。

## GitHub 发布

[CI](../.github/workflows/ci.yml) 在 Node 24.x 安装完整开发依赖、执行检查和测试，再生成候选 tarball；独立 Node 22.19.0 作业安装同一 tarball，检查 CLI 不隐式安装宿主 SDK，再显式安装锁定的 Pi SDK，验证扩展、工具、技能和资料初始化。独立消费者作业仅验证 Pi/CLI，不安装 dsh 开发依赖，不调用模型；全量测试中的 dsh 本地 SDK 测试不代表候选包的包根 Web 加载和 Remote 传输已自动验收。dsh 原生安装与界面按上述步骤单独验证。[发布工作流](../.github/workflows/publish.yml)要求：

- tag 为 v<稳定版本>，包与锁文件版本一致。
- 提交已进入远端默认分支。
- 目标 npm 版本不存在，registry 返回明确 404。
- 通过 npm Environment 中配置的审核。

将审核后的提交推送到默认分支，再推送对应 tag：

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

发布作业下载本次 CI 的同一 tarball，使用 OIDC 和 provenance 上传，跳过包脚本，然后查询公开版本与 latest。npm 可能在上传成功后继续处理包，查询最多执行 20 次，失败后间隔 15 秒；只重试只读查询，不重试上传。普通分支推送只运行 CI；已发布到 npm 的版本及对应 tag 保持不变。只有 registry 明确返回该版本 404、此前未执行上传，并经维护者同意时，才可在修复和检查后将失败发布的 tag 更新到修复提交，继续发布同一版本；更新前再次核对 registry，并用远端旧 tag 对象限定推送，避免覆盖并发修改。预发布版本不适用此流程。

## 本机发布

维护者完成候选检查，在自己的终端登录并核对账号：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm view personal-bot versions --json --registry=https://registry.npmjs.org
```

确认目标版本未占用后，发布已检查的 tarball：

```bash
VERSION=$(node -p "require('./package.json').version")
npm publish "./personal-bot-$VERSION.tgz" --ignore-scripts \
  --access public --tag latest --registry=https://registry.npmjs.org
```

首次包不存在可返回 E404；认证或网络错误需先处理。本机发布通过 npm 官方登录和 2FA 完成，不提供 GitHub provenance。凭据与验证码留在维护者终端，不进入聊天、Git 或日志。

## 发布后验收

```bash
VERSION=$(node -p "require('./package.json').version")
npm view "personal-bot@$VERSION" version --registry=https://registry.npmjs.org
npm view personal-bot dist-tags --json --registry=https://registry.npmjs.org
```

在独立 npm cache/prefix 中从公开 registry 全新安装发布版本，验证 npx 入口与全局 pbot 命令。再在独立 Pi 配置和临时工作区执行 `pi install --local npm:personal-bot`，核对安装版本、扩展加载、技能发现和 /pbot status。

按[dsh 使用说明](dsh.md)，使用当前 dsh 和 pnpm，在独立 profile 中通过原生插件命令安装公开 registry 的目标版本，记录实际宿主与插件版本，核对 Host 启用、包根 Web 客户端加载、`/pbot` 管理页及 Remote 查询。安装与无模型检查不代表成功模型工作流已验收，结果记录在[验证](validation.md)。

上传结果不明时先查询 registry。若上传完成但后续查询失败，手动运行 Publish npm，选择原版本 tag 并保持 verify_only=true。该模式重新执行检查与 registry 查询，不上传；目标版本已不是 latest 时会失败。不要直接重跑原上传作业，也不要移动已发布 tag。

已发布版本不可覆盖。问题修复由维护者选择新版本、弃用说明或 dist-tag 调整。2026-11-06，提交 `1625a78af324de412ba12b0689de6c9ebde61698` 的 0.2.6 已通过 OIDC 发布及公开版本/latest 查询；公开 registry 只读核对确认该版本存在、latest 为 0.2.6，且包含 dsh Host/Web 入口。0.2.6 从公开 registry 全新安装的 npx、Pi 与 dsh 验收仍待完成，证据及范围见[CI 与发布记录](validation.md#ci-与发布2026-11-06)。
