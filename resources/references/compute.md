# Python 计算

环境上下文的 `python.state` 是当前共享环境状态。ready 时通过 Bash 使用 `python` 或 `python3`，直接导入第三方库。项目构建和测试使用项目声明的环境。

## 环境异常

未就绪或依赖异常时可自主诊断，只暂停依赖该环境的计算，不退回系统 Python，不删除或重建共享环境。完整准备错误可在 `/pbot status` 查看，修复后用 `/pbot python setup` 重试；需要用户执行会话操作时说明入口，专家向主会话交回所需条件。

所有 pbot 工作区共用该环境。更改依赖会影响其他工作区，停止相关计算后再更新。安装与许可信息见 [Python 说明](../../python/README.md)。

## 按项目运行

沿用项目的工作目录、脚本或模块入口、输入参数与输出位置。包内相对导入通常使用项目根目录下的 `python -m 包.模块`，不为绕过导入错误随意改 `sys.path`。相对数据路径取决于 cwd 或脚本自身的处理；交付时提供实际产物路径，并检查结果。

预装库包括 NumPy、pandas、SciPy、statsmodels、scikit-learn（导入名 sklearn）、Matplotlib、seaborn、Bokeh、openpyxl、PyArrow、TA-Lib 和 backtesting。按任务查阅当前版本的原生 API。

- 无图形界面的绘图：在导入 pyplot/seaborn 前选择 Matplotlib 的 Agg 后端，保存文件并关闭 figure。
- Excel、Parquet、Feather：按格式选择 openpyxl 或 pyarrow；核对读写后的字段类型、时间单位与时区。Excel 不直接保存带时区的 datetime，转换前明确目标时区。
- 统计或建模：记录数据与假设。时间序列按时间切分，预处理只在训练数据拟合，避免未来数据泄漏。
- 技术指标或回测：再读 [指标与回测](compute-finance.md)，按本次问题确定数据口径和交易假设。
