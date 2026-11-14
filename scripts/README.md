# 维护脚本

## 构建

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 清理 dist，编译测试模块，再构建 CLI 与 dsh 产物 |
| `npm run build:cli` | 清理 lib，编译独立安装器、Pi 检查桥接与启动保护 |
| `npm run build:dsh` | 编译 Host，将 TypeBox 与许可证纳入 lib，再构建原生 Web Loader 模块 |

完整构建与 prepack 先构建 CLI，再构建 dsh。宿主 SDK 保持 external；dsh 编译模块引用包内 TypeBox，原模块位置保留。Pi 扩展由宿主直接加载 src。

## 安装包检查

先运行 `npm pack`，再将生成的 tarball 路径传给检查脚本：

| 命令 | 检查内容 | 环境 |
| --- | --- | --- |
| `node scripts/check-consumer.mjs <tarball>` | 独立 CLI、Pi 扩展、技能、工具与资料初始化 | CI 使用 Node.js 22.19.0，脚本安装锁定的 Pi SDK |
| `node scripts/check-dsh-consumer.mjs <tarball>` | dsh 原生插件安装、独立 CLI 与 Host 导入；检查无需单独安装 TypeBox 或宿主 SDK | Node.js 24.9+、仓库开发依赖和 PATH 中的 pnpm |

脚本使用隔离的用户目录、宿主配置与工作目录，完成后清理临时目录。两项检查均不调用模型；Pi 使用预置故障目录跳过 Python 依赖下载，dsh 通过原生 schema 收集导入 Host。

## ACP 真实模型 E2E

在已配置 Pi、dsh、Claude 原生模型与认证的环境执行 `npm run test:e2e:acp`。该命令在临时工作区调用三个真实后端，省略 model、thinking 和 provider 验证默认值；另测 Claude 显式 low 覆盖原生环境 max。检查文件结果、报告分页、停止耗时，并对照 Claude 原生请求中的模型与思考等级。它单独运行，不进入 `npm test`。

入口默认从 PATH 查找。可用 `PBOT_ACP_E2E_PI_COMMAND`、`PBOT_ACP_E2E_DSH_COMMAND`、`PBOT_ACP_E2E_CLAUDE_COMMAND` 指定已有可执行文件路径；dsh 仍使用 acp profile。`PBOT_ACP_E2E_OUTPUT_DIR` 指定输出目录，默认使用临时目录；每个工作区保留 input.json、output.json、report.txt 和 result.json；Claude 用例还保留仅含模型与等级的 native-requests.json。

## Python 准备

`setup-python.py` 按 `python/requirements.lock` 准备用户共享 venv。Personal Bot 加载时自动调用，也可运行独立脚本或 `/pbot python setup`。路径、依赖与排障见 [Python 说明](../python/README.md)。
