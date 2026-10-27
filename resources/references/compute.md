# Python 计算

## 环境

主会话与专家的 `pbot_environment.python` 给出当前共享 Python 3.11+ 环境状态。为 ready 时，通过 Bash 使用 python 或 python3，按任务导入第三方库原生 API。项目构建和测试明确要求另一环境时，按项目约定在对应命令中使用。

状态未就绪或依赖异常时，暂停依赖该环境的计算并说明问题，不自动退回系统 Python，不删除或重建环境。主会话修复后可用 `/pbot python setup` 重试；专家交回错误，由主会话处理。额外依赖或环境变更须取得用户同意。

所有 pbot 工作区共用当前用户的环境。更新依赖前停止相关计算，避免影响其他工作区；不同插件版本的依赖要求可能冲突。库清单说明可用方法，不代替本次环境状态检查。

## 预装原生库

| 库 | 常用导入 | 用途 |
| --- | --- | --- |
| NumPy | `import numpy as np` | 数组与数值运算 |
| pandas | `import pandas as pd` | 行情表、时间序列和文件读写 |
| TA-Lib | `import talib` | 技术指标与形态函数 |
| backtesting | `from backtesting import Backtest, Strategy` | 策略回测 |
| SciPy | `from scipy import stats, optimize, signal` | 统计检验、优化、信号处理 |
| statsmodels | `import statsmodels.api as sm` | 回归、时间序列、统计诊断 |
| scikit-learn | `import sklearn` | 预处理、预测模型、聚类与评估；导入名为 sklearn |
| Matplotlib | `import matplotlib.pyplot as plt` | 保存静态图表 |
| seaborn | `import seaborn as sns` | 基于 Matplotlib 的统计图表 |
| openpyxl | `import openpyxl` | Excel `.xlsx` 读写；也可用 pandas 的 openpyxl 引擎 |
| PyArrow | `import pyarrow as pa` | Arrow、Parquet、Feather；也可用 pandas 的 pyarrow 引擎 |
| Bokeh | `from bokeh.plotting import figure` | 交互式 HTML 图表，backtesting 绘图也使用它 |

这些库提供计算能力，不替代数据依据、统计假设或验证。时间序列建模按时间切分训练与验证数据，预处理只在训练集拟合，避免未来数据泄漏。

## 脚本、模块与产物

已有脚本按项目文档在原位置运行，核对工作目录和入口。例如，替换以下占位路径后，从项目根目录运行脚本：

```bash
cd "/项目根目录" && python scripts/analyze.py --window 20
```

环境中只有 python3 命令时，将示例中的 python 换成 python3。包内相对导入通常使用模块入口，例如在项目根目录执行 `python -m analysis.main --window 20`。普通脚本导入同目录模块与 `-m` 的包导入遵循 Python 原生规则；不要为绕过错误随意改 sys.path。相对数据路径取决于工作目录或脚本自己的路径处理，应先核对约定。临时计算也可使用 `python -c` 或标准输入。

按脚本或项目约定提供输入、参数和结果位置，使用实际 Bash 工具的超时与取消能力。需要复用的研究保存源码、参数、必要输入、数据来源、时间、单位和结果引用；正式产物归关联项目或长期事务，临时产物使用 scratch。保留已有研究证据，不为整理资料自动重算。

Python 具有宿主文件和网络权限，不是沙箱；不得超出本次任务授权执行业务变更或改写历史记录。取消不回滚已发生的副作用。

## 绘图与文件

在无交互式图形界面的执行环境中使用 Matplotlib/seaborn 时，在导入 pyplot 或 seaborn 前选择 Agg 后端，保存图像并关闭 figure，不调用 `plt.show()`：

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([1, 2, 3], [10, 12, 11])  # 示例数据，不是行情证据
fig.savefig("chart.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

文件按项目约定保存并交回实际产物路径；相对输出路径基于所选工作目录。Excel 可用 `pd.read_excel(path, engine="openpyxl")` 与 `df.to_excel(path, index=False, engine="openpyxl")`；Parquet 可用 `pd.read_parquet(path, engine="pyarrow")` 与 `df.to_parquet(path, index=False, engine="pyarrow")`。Feather 使用 `pd.read_feather` / `df.to_feather`。检查读写后的字段类型、时间单位与时区；Excel 不直接保存带时区的 datetime，转换前明确目标时区，不默默丢弃时区含义。

## TA-Lib 技术指标

使用原生 API，不需要指标包装层。常用函数包括 `SMA`、`EMA`、`MACD`、`RSI`、`BBANDS`、`ATR`、`ADX`、`STOCH`、`OBV` 和 `CDL*` 形态函数。用 `talib.get_function_groups()` 或 `talib.get_functions()` 查找能力，用 `help(talib.函数名)` 核对参数与返回值，不凭名称猜测。

以下脚本从第一个命令行参数指定的 JSON 文件读取 close 数组，计算均线并输出严格 JSON：

```python
import json
import sys
import numpy as np
import talib

with open(sys.argv[1]) as file:
    data = json.load(file)
close = np.asarray(data["close"], dtype=np.float64)
sma = talib.SMA(close, timeperiod=20)
print(json.dumps({"sma20": [float(x) if np.isfinite(x) else None for x in sma]}, allow_nan=False))
```

使用前核对时间顺序、复权口径、缺失数据、单位和样本长度。多输入函数要求 OHLCV 数组按同一时间轴对齐。backtesting 策略可通过 `self.I(talib.SMA, self.data.Close, 20)` 注册指标。

- `talib.MACD` 返回 `(macd, signal, hist)`，`hist = macd - signal`，不乘 2。
- `talib.BBANDS` 返回 `(upper, middle, lower)`，默认使用 SMA 中轨和两倍总体标准差。
- 暖机期输出 NaN；例如 SMA(20) 前 19 根、RSI(14) 前 14 根不可用。EMA、RSI 等按 TA-Lib 的种子与平滑规则计算，不等同于直接 pandas ewm。
- NaN 输入可能影响后续输出，不擅自填零或把暖机值当成信号。持平序列的 RSI 在暖机后为 0，不是 50。
- 指标可计算不证明策略有效。记录参数、TA-Lib 版本与数据依据；生成严格 JSON 时把非有限值转为 null。

## backtesting 原生回测

直接使用 `from backtesting import Backtest, Strategy`。继承 Strategy 定义 `init()` 和 `next()`，通过 `Backtest(data, 策略类, ...).run()` 运行。数据使用按时间升序的 OHLC DataFrame，可带 Volume，建议使用 DatetimeIndex；以当前安装版本的 API 为准。

- 显式确定资金、手续费、价差、成交时点与仓位假设，不把库默认值当作投资规则。
- 原生 Backtest 不自动提供 A 股 T+1、整手买入、涨跌停或交易日历约束。研究需要这些规则时，必须明确建模并验证；无法表达时说明限制，不能直接声称结果适用于该市场。
- 按研究问题决定是否划分样本内/样本外及如何暖机，不默认套用固定回测流程。避免未来数据泄漏。
- 原生结果可能包含 Series、DataFrame、时间和非有限值；按需要提取统计与交易记录，再转为可保存的数据，保留数据来源、参数及库版本。

环境与许可信息见 [Python 说明](../../python/README.md)。
