# 维护脚本

## Python 环境准备

`setup-python.py` 创建当前用户的共享 venv，按 requirements.lock 安装依赖。Personal Bot 加载后自动调用；也可独立执行，或通过 /pbot python setup 重试。

脚本不接受解释器路径，不修改工作区资料或历史记录。路径、激活和失败处理见 [Python 说明](../python/README.md)。

## 安装 CLI 构建

`npm run build:cli` 调用 `build-cli.mjs`，清理生成目录 lib，再按 tsconfig.cli.json 编译独立 CLI、Pi 检查桥接和启动保护。bin/pbot.mjs 转交已生成的入口。npm test 的构建与 prepack 都执行此步骤；扩展运行仍由 Pi 加载 src 源码。消费者直接使用发布包中的 lib，无需安装开发依赖。

## 构建清理

`clean-dist.mjs` 由 npm run build 调用，仅清理仓库内生成的 dist/，供 TypeScript 重新编译测试导入。

本包不提供工作区升级命令或历史转换脚本。插件安装和更新由 Pi 原生包管理或用户维护的源码目录负责。
