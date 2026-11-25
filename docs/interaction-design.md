# 界面设计

风格简洁，标签和说明尽量短。常用状态与操作直接可见，高级配置和原始数据按需展开。各宿主共享业务规则，分别使用宿主主题与原生能力。Claude 接入的当前状态见[使用指南](claude-code.md)。

## Pi TUI

`/pbot` 提供精简命令入口：`/pbot init` 初始化并启用工作区，`/pbot status` 以纯文本或 JSON 通知输出状态，`/pbot enter [专家]` 通过 Pi 原生选择列表附着到自有 Pi 原生专家的 tmux 会话以查看交互历史。ACP 权限请求与工作区外文件修改继续进入已有确认队列，后台提示最多显示四位专家；专家、团队和历史操作交由模型工具完成。

## dsh GUI

工作台分工作区、专家、团队、历史四页。宽窗口使用侧边导航，窄窗口使用顶部导航与单列布局。专家列表支持筛选；表单、记录和高级设置分开呈现。查询与提交显示各自结果，不把任务排队当作完成。创建专家可选择运行宿主；原生成员展示原生记录，ACP 成员展示任务与周期报告。运行中的 ACP 消息使用下一轮投递。工作区页集中展示专家待确认操作，由人工选择目标提供的选项。

轮询保留表单草稿、输入焦点和分页。关闭取消查询及未接纳上传；已接纳操作归服务端。查看页面不恢复专家、不领取模型通知。

## Claude 原生入口

Claude 使用原生技能和 Agent/teams 界面。`/personal-bot:pbot init`、`status` 是标准技能请求，由模型通过 Bash 调用同一 Node CLI；需要确定性执行时直接运行 `node <plugin>/lib/claude.js init|status`。状态输出集中展示工作区与配置信息。

专家由原生 Agent 使用 `personal-bot:general-purpose` 创建，团队的成员、通信、任务和完成通知由 Claude 管理。用户自行设置实验团队开关与 teammate mode；返回会话后明确要求继续，原生 resume/rewind 不恢复进程内 teammate。

Claude 插件不提供 pbot 管理面板或历史页；跨 Harness 专家调度通过内置 `.mcp.json` 的 `pbot_agent` 工具完成，见[轻插件宿主与跨 Harness 接入设计](plugin-hosts-design.md)。

## Antigravity 原生入口

Antigravity 通过原生插件清单、`hooks.json`、技能、静态专家与内置 `mcp_config.json` 接入，不提供定制 TUI 或管理面板。`/pbot init` 与 `/pbot status` 通过原生技能调用 `node <plugin>/lib/plugin.js antigravity init|status`。同宿主专家委派使用原生 `invoke_subagent`（`general-purpose` / `research`）与 `/swarm`，跨 Harness 委派使用内置 MCP 工具 `pbot_agent`。通过 `npx personal-bot@latest install-antigravity` 或 `agy plugin install <plugin-dir>` 安装插件。
