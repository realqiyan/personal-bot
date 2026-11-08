# 工作区配置

Pi 和 dsh 共用工作区根目录下的 `.pbot/config.json`。宿主原生配置负责安装和加载插件，此文件决定 Personal Bot 是否在当前工作区启动，也作为后续工作区功能配置的统一入口。

## 初始化与状态

安装后，从目标工作区打开 Pi 或 dsh，在聊天框执行：

```text
/pbot init
/pbot status
```

`init` 补建资料目录和缺失的根 `AGENTS.md`，将配置中的 `enabled` 设为 true，并启动 Personal Bot。已有资料和其他配置字段保留。Pi 在首次启用时自动重载；dsh 立即启用此目录下已打开的主会话。已经启动时，再次执行 `init` 主要用于补建资料；Pi 新建的根 AGENTS 经 `/reload` 加载。

Pi 状态栏显示“PBot 未启用”或“PBot 已启动”。dsh 的 Personal Bot 工作区页显示状态，未启用时提供“初始化并启用”按钮。两种宿主都保留 `/pbot status`，其结构化状态包含 `enabled`、运行时 `state`、工作区路径和配置路径。`state` 表示当前运行状态，取值为 `disabled`、`running` 或 `error`。

## 启用与停用

初始化后的配置为：

```json
{
  "enabled": true
}
```

例如，ONEBASE 使用 `~/onebase/.pbot/config.json`。同一 dsh profile 可以同时打开开启和关闭的工作区。

| 配置情况 | 行为 |
| --- | --- |
| `enabled: true` | 启动工作区实例，加载工具、提示词和包内技能，并准备 Python |
| 文件不存在、缺少 enabled 或 `enabled: false` | 保持未启用，提示执行 `/pbot init`；保留宿主原生功能 |
| JSON 损坏、字段类型错误或文件不可读取 | 保持未启用，报告配置错误；修复文件后再执行 `init` |

未启用时，包内技能不会进入原生技能目录，也不注入 pbot 提示词。用户自己的 AGENTS、技能和其他插件仍按宿主配置加载。

只读取当前工作区根目录，不向父目录查找配置。在 `~/onebase/projects/example` 单独建立会话时，该目录需要自己的配置。受 Personal Bot 管理的专家沿用所属工作区的启用决定，专家的工作目录可以不同。

配置使用普通 JSON，当前支持可选的布尔值 `enabled`。其他字段原样保留，后续工作区功能也在此文件中配置。

## 应用手工修改

- **Pi**：修改配置后执行原生 `/reload`，或重新启动 Pi。
- **dsh**：修改配置后重启对应服务或桌面宿主。

手工修改前已加载的会话保持原配置。修改 cwd 不改变所属工作区。停用后重载会撤下工具并释放所属专家、团队调度和历史整理；资料、历史与备份保留。需要重新启用时可直接执行 `/pbot init`。

所有已启用工作区共用用户级 Python venv。dsh 的进程环境激活由整个插件组件持有，同一 Host 中的 Bash 进程可能继承该环境。Python 使用方式见[计算环境](../python/README.md)。

## 安装与更新

插件安装完成后，通过 `/pbot init` 创建启用配置并启动工作区。`pbot setup` 可在安装后启动 Pi 执行此命令；手工安装后，在目标工作区的聊天框执行。

从此前“加载即启动”的版本更新后，同样通过 `init` 启用目标工作区，保留现有安装配置、资料和历史数据。
