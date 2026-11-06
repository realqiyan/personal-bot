# 指标与回测

## TA-Lib

通过 `import talib` 使用原生函数。用 `talib.get_function_groups()`、`talib.get_functions()` 和 `help(talib.函数名)` 核对能力、参数与返回值。

计算前核对时间顺序、复权、缺失数据、单位与样本长度，多输入 OHLCV 数组必须按同一时间轴对齐。保留影响结果解释的原生规则：

- `MACD` 返回 `(macd, signal, hist)`，其中 `hist = macd - signal`，不乘 2。
- `BBANDS` 返回 `(upper, middle, lower)`，默认使用 SMA 中轨和两倍总体标准差。
- 暖机期为 NaN，例如 SMA(20) 前 19 根、RSI(14) 前 14 根不可用。EMA、RSI 的种子和平滑规则不等同于直接 pandas ewm；持平序列的 RSI 暖机后为 0，不是 50。
- NaN 输入可能影响后续输出，不擅自填零或把暖机值当成信号。严格 JSON 中将非有限值转为 null。

记录参数、库版本与数据依据；指标可计算不证明策略有效。

## backtesting

用 `from backtesting import Backtest, Strategy`，通过 Strategy 的 `init()`、`next()` 定义策略，再运行 `Backtest(data, 策略类, ...).run()`。数据为按时间升序的 OHLC DataFrame，可带 Volume；参数以当前版本 API 为准。TA-Lib 指标可用 `self.I(talib.SMA, self.data.Close, 20)` 注册。

显式确定资金、手续费、价差、成交时点与仓位假设。原生 Backtest 不自动提供 A 股 T+1、整手买入、涨跌停或交易日历约束；任务需要时明确建模和验证，无法表达时说明限制，不把默认值当作市场规则。

按研究问题选择样本内外划分及暖机方法，避免未来数据泄漏。交付时说明参数、版本与限制，按需保留统计和交易记录；导出时处理 Series、DataFrame、时间和非有限值。
