# 架构治理工作台

## 范围与验证入口

依赖图按当前 checkout 生成。运行 `npm exec -- depcruise --include-only '^src/' --config .dependency-cruiser.cjs -T dot src > dependencies.dot` 生成逐模块依赖图，使用 `npm run check` 检查环、解析失败与越层依赖。源码权责见[技术设计](../architecture/design.md)，工作区、控制记录及历史文件的路径以该文的存储表为准。

| 概念 | 状态所有者与流向 | 变更或验证入口 |
| --- | --- | --- |
| 宿主装配与上下文 | Pi Lifecycle、dsh DshWorkspaces 随会话持有实例；无状态 hook 每次解析绑定根和配置 | hosts 适配器、plugin-registry、各宿主集成测试 |
| Web 与 TUI | dsh 管理页持有显示状态，经 Typert 调用宿主；Pi 原生通知和确认队列绑定当前实例 | ui/dsh、ui/pi、tests/dsh、tests/ui |
| 工具与协议 | 模型工具输入经适配器校验，服务实施查询和控制；MCP stdio 负责请求、响应与进度通知 | tools/history、extension/mcp、tests/tools、tests/mcp |
| 工作区配置 | workspace-config 校验 opt-in、功能、摘要和 ACP 配置；workspace-mcp 校验、展开并写共享服务定义 | tests/workspace/config、tests/integration/workspace-config |
| 原始历史与派生状态 | 宿主采集 → history-capture → HistoryFiles；维度规划、锁、指纹与摘要执行由 summary-runner 协调 | tests/history、tests/storage、tests/dsh/history |
| Worker 与交互 | AgentService 管理 owner、生命周期和请求；AgentFiles 管理 generation 与队列；ACP 子进程交换模型选择、权限、表单及输出 | services/agents、integrations/acp、extension/acp、tests/agents |
| 连接与缓存 | 每个 MCP runtime 持有工作区服务实例与下游连接；退出时释放。原生挂载由宿主 SDK 释放 | extension/mcp/bridge、Pi、dsh、tests/mcp/workspace-bridge |
| 权限与凭据 | 工作区外写入交宿主确认，worker 的权限和 elicitation 由 ACP 会话处理，环境与认证由接入方提供 | workspace-files、ui/pi/confirmation、integrations/acp/input |
| 异常、重试与观测 | 存储写锁返回可辨识的 busy 错误；协议边界把异常转成相应传输结果；宿主负责日志、进度与取消 | storage、services/history、extension/mcp、各宿主边界 |
| 安装与分发 | package.json 管理发布版本；锁文件固定依赖；CLI、dsh、插件构建按序生成消费者产物 | scripts、smoke、CI 的 npm 包消费者检查 |

## 当前任务池

| 状态 | 证据与行动 |
| --- | --- |
| 已治理 | Pi 与 dsh 均从 hosts/history-command 执行历史命令。dsh 聊天命令直接使用已验证的工作区，Web 继续通过 Typert。宿主持有取消信号和进度展示。 |
| 已治理 | MCP 调用字段从 tool-contract 的公开 schema 提取，十份手写字段表已删除。工具名联合类型使执行分派具备编译期穷尽检查。 |
| 已治理 | bridge 以同一记录持有握手与就绪连接。新配置立即建立连接；旧配置的调用完成后释放旧会话。双 HTTP 端点测试在握手期间切换配置并验证各自的身份与清理。 |
| 已治理 | runtime.nativeServer 从已创建实例取得 worker 控制目录与会话 ID，生成 Pi/dsh 的挂载参数；两个宿主各自管理 SDK 注册、超时单位与环境继承。 |
| 已治理 | 工作区 MCP 配置写入在文件锁内读取最新值并原子发布，仅更新 mcpServers，保留用户顶层扩展字段和未展开的模板。CLI 并发新增与删除均由真实进程覆盖。 |
| 已治理 | AgentHost 与安装器能力类型在 model 定义。服务与适配器都依赖这些类型，dependency-cruiser 同时检查类型边和运行时边，限制 Pi/dsh SDK 的直接导入位置。 |
| 已治理 | historyPageLimits 与历史标识语法供服务、原生工具、MCP 和 Web 使用。MCP 编排无需再从存储模块导入标识校验。 |
| 已治理 | 历史列表、全文检索和节点回读使用同一摘要身份，Web 可使用返回的 host 打开跨宿主月度摘要。 |
| 已治理 | 工作区历史访问统一解析布局。状态与启动提醒共用只读维度规划，提醒继续在历史较新时提前返回；三个宿主入口共用启动通知。 |
| 已治理 | 历史迁移对两类文件使用同一条路径生成和报告流程。存储检查预览与实际目的路径，在删除原文件前同步目标目录。 |
| 已治理 | dsh Web 的历史与工作区两页保留正在使用的输入、来源标记与布局；已移除旧 worker 面板的状态映射、控件和样式。 |
| 已治理 | Pi 只暴露一个原生历史工具。其注册函数随实例返回隐藏操作，已删除通用工具注册表及历史工具用不到的文件写入权限接口。 |
| 已治理 | 工作区权限、历史布局、worker 状态和回复动作由数据契约声明可选值；配置和控制记录按实际 JSON 类型校验。摘要默认并发数与上限由模型常量提供。 |
| 已治理 | MCP 完成配置读取后再次检查运行时是否关闭。历史与外部服务请求独立执行，只有 worker 调用建立 AgentService。同一实例的重复关闭共用清理结果。 |
| 已治理 | Pi/dsh 主会话与 ACP 成员共用原生 MCP 加载流程，个别服务失败只影响该项；ACP 协议透传继续严格校验整份配置。 |
| 已治理 | build:plugins 编译一次独立运行时，再将同一份文件放入 npm 与 Antigravity 包。三个构建入口共用锁定的 TypeScript 编译器。 |
| 已治理 | 摘要在锁外生成，锁内核对规划时的产物。并发任务使用相同来源时复用已发布结果，来源冲突进入该项失败报告；下游月度任务读取已发布的会话摘要。 |
| 已治理 | worker 命令直接解析公开工具名和短名。AgentService 在一次状态读取中匹配代次、请求与周期；MCP 轮询只负责等待和呈现，私有字段阻止其再访问消息存储。 |
| 已验收 | 全库扫描覆盖 115 个源码模块、415 条内部依赖。当前任务池中可安全独立实施的项目均已提交，余项见下方验收边界。 |

## 决策记录

| 主题 | 采用的方案与取舍 | 防回归入口 |
| --- | --- | --- |
| 历史命令 | 共用编排函数解析和执行。Pi 与 dsh 各自保留会话校验、取消及结果展示。将 SDK 调用下沉到服务会引入宿主依赖，各宿主独立执行则需要同步修改业务分支。 | 宿主集成测试、services 依赖规则 |
| 工具契约 | 工具定义提供字段名和公开描述，执行层检查具体值、授权与功能开关。服务端可以独立分发。原生工具的 TypeBox 与 MCP 的 JSON Schema 各自满足其宿主加载约定。 | 工具契约与 stdio 测试、TypeScript 穷尽检查、安装包检查 |
| 下游连接 | 一个运行时管理握手、已就绪连接和仍被请求使用的旧连接。切换配置时为新调用建立新连接，完成旧请求后释放。全局串行会让一个慢服务阻塞其他请求。 | 双 HTTP 端点测试、关闭时仍在读取配置的请求测试 |
| 配置发布 | 进程在短目录锁内重读并原子替换 JSON。原子替换单独只能保证文件完整，无法保留并发编辑。锁超时提示操作者核实持有进程。 | 12 个独立 CLI 进程增删、用户元数据回读、原子文件测试 |
| 摘要发布 | 模型工作在锁外进行，发布时核对同一产物的规划基线。相同来源复用先发布的结果，来源冲突保留当前文件并报告任务失败。长时间持锁会阻塞同维度的无关摘要。 | 两次相互交叠的真实文件写入、增量和强制重建测试 |
| 原生挂载 | 共享工作区服务的解析和逐项加载，Pi 与 dsh 各自持有 SDK 注册和释放。ACP 透传以整份会话配置为单位校验。三种接口的超时单位、错误范围和生命周期仍由各自契约规定。 | 原生 Pi/dsh 工具发现、ACP 成员与传输测试 |
| 分发 | 在独立临时目录编译一次插件运行时，再分别组装 npm 与 Antigravity 产物。从整个 lib 复制会把同目录的 dsh 和 CLI 专用产物带入插件。 | 包内真实宿主加载、解包后独立执行、原生清单校验 |

## 技术方案与保留边界

- Pi 原生扩展、dsh Cordis 与 Typert、无 SDK 的轻插件 hook 分别对应三类宿主加载契约。Pi 使用原生 TUI，dsh Web 使用宿主组件与样式。新增轻插件通过 PluginHostRegistry 扩展。
- 跨宿主调度采用 stdio MCP 与 ACP v1。下游 MCP 同时支持 stdio 和 Streamable HTTP，各自负责进程或 HTTP 会话。模型选择、环境变量及身份凭据由接入方提供。
- JSON 文件承担工作区与进程间的持久化。原始历史是摘要输入，摘要按来源指纹派生。原始记录、worker 控制代次、跨宿主历史标识、平铺读取和显式迁移分别有现行消费者。
- 开发与发布使用锁定的 TypeScript、esbuild、Node 测试与原生插件校验器。维护脚本说明运行版本、命令和独立安装检查。详见[维护脚本](../../scripts/README.md)。

## 待确认与验收边界

| 事项 | 当前行为与再次开启的条件 |
| --- | --- |
| 写入进程异常退出后的遗留锁 | 超时后报告锁路径，由操作者核实。跨进程自动接管需要先确定如何可靠识别仍存活的持有者。 |
| 真实模型端到端验收 | 普通回归使用本地文件、协议进程和宿主 SDK。模型账号下的行为按仓库约定在获准的专用环境单独验收。 |


## 本批验收

| 验收面 | 结果 |
| --- | --- |
| 依赖方向 | TypeScript 和 dependency-cruiser 通过。依赖图包含 115 个源码模块，检测到 0 个环、0 项规则违规。临时违规导入验证了 services 类型依赖与 Pi、dsh SDK 所有权规则。 |
| 公开协议 | 从基线提交 `9d4fcc2` 独立构建 stdio MCP，在工作区绑定、功能开关、原生挂载的四组配置下对比初始化和工具发现，全部响应内容一致。 |
| 本地回归 | Node 24.22.2 上全量构建，134 项测试通过。覆盖真实文件、隔离进程、并发写入、跨宿主历史与原生加载。 |
| 分发与宿主 | 同一 npm 包在 Node 22.19.0 通过 Pi 和 Claude 消费者检查，在 Node 24.22.2 通过 dsh 消费者检查。Claude、Antigravity、Qoder 原生校验均通过。Claude 提示缺少作者、图标；Antigravity 提示使用通用图标。 |
