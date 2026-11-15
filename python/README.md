# Python 共享虚拟环境

所有 pbot 工作区共用当前系统用户的独立 Python 3.11+ venv。通过原生 Bash 执行普通脚本或模块，直接导入第三方库；没有 Python 计算执行工具或自定义计算包。Pi/dsh 激活进程环境后使用 `python` 或 `python3`；Claude 使用 `python.executable` 的完整路径。

## 自动准备与使用

工作区的 `.pbot/config.json` 设置 `enabled: true` 后，Pi 加载或原生 `/reload` 时自动执行 setup；dsh 在首个已启用工作区加载时准备环境；Claude 在 SessionStart 和后续用户请求 hook 中检查并准备环境。无需另行确认或指定 Python 路径。同一系统用户的 Pi、dsh、Claude 共用该环境：

1. 共享 venv 不存在时创建，不使用系统 site-packages；解释器无法启动时重新创建。
2. 按 `requirements.lock` 补齐或对齐依赖，允许升级或降级；已匹配时不重新安装。
3. 检查依赖关系、全部预装库导入和简单 TA-Lib 计算。

| 系统 | 共享环境 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/pbot/python/.venv`；仅使用绝对 XDG_DATA_HOME |
| macOS | `~/Library/Application Support/pbot/python/.venv` |

首次准备从当前 PATH 选择 python3，无该命令时使用 python；需要 Python 3.11+ 和 venv/ensurepip。系统 Python 只用于创建独立 venv，不在系统环境中安装依赖。已有 venv 按锁文件对齐，保留额外安装的包。基础解释器被移除或升级、导致共享 venv 的解释器无法启动时，setup 用当前 Python 3.11+ 重建该 venv，原有包随之移除；非 venv 数据、符号链接和其他 Python 环境不会被覆盖或删除。

首次安装可能需要数分钟和网络。各宿主的 init 入口创建共用启用配置并准备环境；不需要 Personal Bot 的工作区可保留配置缺失或设置 enabled 为 false。Pi/dsh 通过 `/pbot status` 查看状态；Claude 使用原生 `/personal-bot:pbot status` 技能，或直接运行 `node <plugin>/lib/claude.js status`。

Pi/dsh 成功后将 venv 的 `bin` 放到所在进程 PATH 前端，设置 `VIRTUAL_ENV`，移除 `PYTHONHOME`、`PYTHONPATH` 并禁用用户 site-packages，原生 Bash 继承该环境。所属激活生命周期关闭时恢复本扩展持有的变量，保留期间其他代码的新修改。dsh 按整个 pbot 组件共享激活，不随浏览器页面或单个工作区关闭而恢复。Pi/dsh 的 ACP worker 独立激活所在进程。

Claude 标准插件不修改 Claude PATH 或环境变量。就绪上下文和 CLI status 提供 Python 可执行文件的完整路径，原生 Bash 用该路径执行脚本；禁用或卸载无需恢复环境。外部终端和 shell 配置不变。

## 失败与手工重试

环境异常时，Pi/dsh 在运行状态中保留错误。Claude 在发生失败的 hook 或当次 `init`、`python setup` 结果中显示错误；后续 `status` 只读检查当前环境，不保存先前进程的安装日志。pbot 的其他能力仍可使用，但不把 Python 标记为就绪，也不替模型自动换用系统 Python 执行研究。原生 Bash 仍然可用。

检查错误后，Pi/dsh 可执行 `/pbot python setup`；Claude 可使用原生 `/personal-bot:pbot python setup` 技能，或确定性执行：

```sh
node /absolute/path/to/plugin/lib/claude.js python setup
```

无需路径参数和额外确认，执行同一准备逻辑。安装限时 15 分钟，超时或关闭会取消准备；不会自动回滚或循环重试。失败留下的环境保留，下次 setup 继续按锁文件补齐。共享 venv 解释器无法启动时自动重建；其他损坏不自动删除环境，可自行删除该目录后重试。缺少 pip 时仅尝试该 venv 的 ensurepip。

安装只接受 wheel，不编译 C 库、不安装系统软件，不绕过系统 Python 的安装保护。没有匹配 wheel、网络不可用、权限不足或环境损坏时停止。TA-Lib wheel 包含底层库，但并非所有系统和架构都有匹配 wheel。pip 安装配置被忽略，避免包被重定向到其他目标。

多个 pbot 进程同时启动时，通过共享排他锁串行准备，后取得锁的进程重新检查。锁文件不删除。该锁不管理普通 Python 进程；更换插件版本或手工重试前，应停止使用该环境的脚本。不同插件版本可能要求不同依赖，不宜同时使用。

## 独立准备

从包根目录运行也会自动准备同一共享环境：

```bash
python3 scripts/setup-python.py
python3 scripts/setup-python.py --check  # 只检查，不创建或安装
```

脚本不接受解释器或目标路径参数，也不能激活其父终端。不修改工作区设置、脚本、历史运行记录或结果。准备脚本支持 Linux/macOS；插件其他宿主依赖仍须满足。dsh 桌面应用从登录 Shell 读取环境，Python 3.11+ 必须在该环境的 PATH 中可见。

## 使用与验证

setup 安装 numpy、pandas、TA-Lib、backtesting、scipy、statsmodels、matplotlib、scikit-learn、pyarrow、openpyxl、seaborn 和 Bokeh。按任务导入，环境与项目运行见[计算参考](../resources/references/compute.md)，需要技术指标或回测时再读[指标与回测](../resources/references/compute-finance.md)。市场规则、费用、成交时点和数据切分由具体研究确定，原生 Backtest 不自动提供 A 股 T+1、整手或涨跌停约束。

Pi/dsh 激活后直接执行 `python scripts/analyze.py` 或 `python -m analysis.main`。Claude 使用状态提供的完整路径，例如 `"/absolute/path/to/shared/.venv/bin/python" scripts/analyze.py`。工作目录、模块导入、参数和结果位置遵循项目约定。项目构建或测试明确要求另一环境时，按项目约定执行。pbot 不复制源码、不生成输入文件或计算记录、不管理研究进程的超时。Python 与 Bash 使用实际账户权限，操作范围见[工具与执行](../docs/capability-design.md)。

在已激活环境中验证；Claude 将以下 `python` 换为完整可执行路径：

```bash
python -m pip check
python -B -m unittest discover -s python/tests -v
```

Node 测试检查环境探测、错误、取消与 Pi/dsh 激活恢复，使用临时 venv 和原生 Bash。上述 Python 测试在已准备的环境中检查原生库配合与文件往返。

依赖版本独立于插件版本。更新锁文件须检查最低 Python 3.11 与目标环境的兼容性，不只按开发机选择最新版。

## 依赖许可

[TA-Lib Python](https://github.com/TA-Lib/ta-lib-python) 使用 BSD-2-Clause，[TA-Lib 底层库](https://github.com/TA-Lib/ta-lib) 使用 BSD-3-Clause。[backtesting.py](https://github.com/kernc/backtesting.py) 0.6.6 使用 AGPL-3.0。具体版本见 requirements.lock。共享环境按锁文件安装依赖，发布包不捆绑第三方 wheel；依赖的使用与再分发须遵循各自许可。
