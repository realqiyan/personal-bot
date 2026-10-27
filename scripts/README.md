# 维护脚本

## Python 环境准备

`setup-python.py` 创建当前用户的共享 venv，按 requirements.lock 安装依赖。Personal Bot 加载后自动调用；也可独立执行，或通过 /pbot python setup 重试。

脚本不接受解释器路径，不修改工作区资料或历史记录。路径、激活和失败处理见 [Python 说明](../python/README.md)。

## 构建清理

`clean-dist.mjs` 由 npm run build 调用，仅清理仓库内生成的 dist/，供 TypeScript 重新编译测试导入。

本包不提供工作区升级命令或历史转换脚本。插件安装和更新由 Pi 原生包管理或用户维护的源码目录负责。
