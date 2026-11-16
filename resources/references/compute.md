# Python 计算

## 按项目运行

使用当前宿主的原生 Bash，沿用项目声明的解释器、依赖、工作目录、脚本或模块入口、输入参数与输出位置。尚无约定时，先检查可用解释器及本次计算需要的库，再选择运行方式。依赖和 Python 版本以项目及所选库的要求为准。

包内相对导入通常使用项目根目录下的 `python -m 包.模块`，不为绕过导入错误随意改 `sys.path`。相对数据路径取决于 cwd 或脚本自身的处理；交付时提供实际产物路径，并检查结果。

解释器或依赖异常时，检查实际路径、导入错误及项目配置，继续不受影响的工作。专家需要主会话协助时交回具体阻碍和所需条件。

## 第三方库

按任务选择当前环境中可用的库，并查阅所用版本的原生 API：NumPy、pandas 用于数组和表格，SciPy、statsmodels、scikit-learn（导入名 sklearn）用于数值分析、统计和建模，Matplotlib、seaborn、Bokeh 用于绘图，openpyxl、PyArrow 用于文件读写。

- 无图形界面的绘图：在导入 pyplot/seaborn 前选择 Matplotlib 的 Agg 后端，保存文件并关闭 figure。
- Excel、Parquet、Feather：按格式选择 openpyxl 或 pyarrow；核对读写后的字段类型、时间单位与时区。Excel 不直接保存带时区的 datetime，转换前明确目标时区。
- 统计或建模：记录数据与假设。时间序列按时间切分，预处理只在训练数据拟合，避免未来数据泄漏。
- 技术指标或回测：再读 [指标与回测](compute-finance.md)，按本次问题确定数据口径和交易假设。
