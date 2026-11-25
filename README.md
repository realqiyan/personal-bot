# Personal Bot

English | [简体中文](README.zh-CN.md)

**A personal assistant connecting knowledge, research, and action.**

Personal Bot is a harness-agnostic workspace and cross-harness specialist layer supporting [Pi](https://pi.dev), dsh, Claude Code, and Antigravity. All hosts share workspace materials, professional methods, and open ACP cross-harness delegation (coding, analysis, and exploration routed to the best-fit harness). Pi/dsh also provide pbot team rounds and history search.

Host guides (Chinese): [Antigravity](docs/antigravity.md) · [Claude Code](docs/claude-code.md) · [dsh](docs/dsh.md).

## Enable a workspace

After installation, open the host in the target workspace and initialize (`Pi`/`dsh`/`Antigravity`: `/pbot init`; `Claude`: `/personal-bot:pbot init`). This prepares missing directories and root `AGENTS.md` and enables the shared `.pbot/config.json`:

```json
{ "enabled": true }
```

A missing, disabled, or invalid config leaves Personal Bot inactive; only the bound workspace root is checked, with no automatic migration. Inspect state with `/pbot status` (Claude: `/personal-bot:pbot status`). See [workspace configuration](docs/workspace-configuration.md) (Chinese).

## Install

### Pi setup wizard

Linux and macOS require Node.js 22.19+ and npm. Run in an interactive terminal:

```bash
npx personal-bot@latest setup
# Or select the workspace directly
npx personal-bot@latest setup --workspace ~/pbot-workspace
```

The wizard selects or creates a directory, installs or updates Pi, and installs Personal Bot for that workspace. Task Conductor and Pi Web Access are selected by default on the first installation; later runs preselect installed plugins. Ordinary npm sources update to the latest stable version. Local, Git, and pinned sources are kept by default, with an option to switch. Deselecting a plugin preserves its installation.

Missing tmux is installed through an existing Homebrew or supported Linux package manager. After installation, the wizard can start Pi and run `/pbot init`. Follow Pi's prompts for project trust, login, and model selection.

For a persistent short command, install the CLI globally:

```bash
npm install -g personal-bot@latest
pbot setup
```

Update this command through npm; Pi manages the workspace extension. If installation fails, fix the cause and rerun setup. Completed steps and existing materials are preserved. An optional plugin failure still allows you to start Pi.

### Existing Pi installation

Run from the workspace root:

```bash
pi install --local npm:personal-bot
pi
```

`--local` saves the installation declaration in the project's `.pi/settings.json`. Once Pi starts, enter `/pbot init` in chat. A global installation can serve several explicitly enabled workspaces. Manage existing sources with `pi list` or `pi config`, keeping one active source per package.

### dsh

You need Node.js 24.9+, npm, and pnpm. Follow the installed dsh release's `engines` if it requires a newer runtime. Use its native profiles and plugin manager:

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# First creation only; this replaces an existing profile of the same name.
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

Select the workspace and a main session in the browser, configure models and authentication, and run `/pbot init` to initialize and enable it. Enter `/pbot` in chat to open management or `/pbot status` to inspect state.

For later starts, run `dsh --profile pbot`. Stop active specialists and the server before updating the plugin:

```bash
dsh plugin --profile pbot update personal-bot --latest
```

The desktop application installs `personal-bot@latest` through its native Plugins page and uses a separate desktop profile. See the [dsh guide](docs/dsh.md) (Chinese) for launcher options, updates, and chat commands.

### Claude Code

Use an interactive Claude Code terminal on Linux or macOS with **Claude Code 2.1.325+** and **Node.js 22.19+**. Install through Claude's native marketplace command:

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

Choose the installation scope through Claude's plugin manager, then use `/personal-bot:pbot init` and `/personal-bot:pbot status` in the target workspace. These are native skills: the model runs the corresponding Node CLI through Bash. For deterministic execution, run `node /absolute/path/to/plugin/lib/claude.js init` or `node /absolute/path/to/plugin/lib/claude.js status` with `CLAUDE_PROJECT_DIR` set to the workspace root. Claude owns login, models, permissions, native agents, teams, and MCP configuration; `pbot setup` remains the Pi installer.

For native teams, the user enables Claude's experimental feature with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` before starting Claude. pbot does not change this setting or provide pbot team scheduling in Claude. Continue work explicitly after returning to a session; native resume/rewind does not restore in-process teammates.

The standard plugin provides materials, skills, and native specialists. Existing Claude history archives and old control records remain preserved. See the [Claude guide](docs/claude-code.md) (Chinese) for operations.

### Antigravity

Requires Linux or macOS, Node.js 22.19+, and the Antigravity CLI (`agy` 1.5+). Install or update via npm:

```bash
npx personal-bot@latest install-antigravity
```

Start Antigravity in the target workspace and run `/pbot init` or `/pbot status`. The plugin wires `SessionStart`/`PreToolUse` hooks, shared skills, `general-purpose` subagent, and the `personal-bot-agents` stdio MCP server for cross-harness ACP delegation. See the [Antigravity guide](docs/antigravity.md) (Chinese).

### Optional: Cross-harness ACP specialists and standalone MCP

Any host can delegate independent tasks across harnesses via `pbot_agent` (native tool in Pi/dsh, bundled MCP in Claude/Antigravity, or `pbot mcp` in any other MCP client). Install the target ACP programs you need:

| Target | Installation | Authentication and model |
| --- | --- | --- |
| Pi | `npm install -g pi-acp` (plus `@earendil-works/pi-coding-agent`) | Run `pi` to sign in and select a default model. |
| dsh | `npm install -g @deepseek-ai/dsh@latest` | Configure the target profile in dsh (default `dsh --profile acp`). |
| Claude Code | `npm install -g @agentclientprotocol/claude-agent-acp` | Sign in or configure API access via Claude Code. |
| Antigravity | Install Google Antigravity CLI (`agy`) | Sign in via `agy` (default `agy acp`). |
| Codex | `npm install -g @zed-industries/codex-acp` | Sign in or configure API access in Codex. |
| Custom ACP | Any ACP v1 stdio server | Declare `{ "command", "args" }` under `.pbot/config.json`'s `acp` map. |

To expose cross-harness delegation to Codex, Cursor, or another MCP host, configure a stdio MCP server running `npx personal-bot@latest mcp` (or `pbot mcp`). See [ACP configuration](docs/workspace-configuration.md#acp-启动配置) and [ACP members](docs/agent-collaboration.md#acp-成员) (Chinese).

### Use from source

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm run build:cli
node bin/pbot.mjs setup
```

To load only the Pi source extension, run `pi install --local /absolute/path/to/personal-bot` from the workspace and keep that source directory and its dependencies available. Run the full `npm run build` before using ACP members or the Claude plugin. The build order is CLI → dsh → Claude because the CLI build clears `lib/`. For dsh, follow the [source installation steps](docs/dsh.md#从源码安装); for Claude, use the [development checks](docs/claude-code.md#依赖与开发检查) (Chinese).

### Optional: Task Conductor

Use `task-conductor-plugin` for schedules, recurring workflows, DAGs, and tasks that continue after the host exits. Install the plugin and its service separately, following the [upstream integration guide](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md).

Pi users run `pi install --local npm:task-conductor-plugin` from the workspace, reload, then read `/skill:using-task-conductor`. dsh users follow the [Task Conductor setup](docs/dsh.md#task-conductor) (Chinese) and read `/using-task-conductor` in the main session.

Notifications return to the session that submitted the task. Service tasks continue after Pi or dsh closes. Query and stop the current run and future recurrences separately.

## Daily use

Describe the task directly: organize materials, compare findings, delegate a review, or run calculations. These commands are for Pi; see the [dsh](docs/dsh.md) and [Claude](docs/claude-code.md) guides for their native interfaces.

| Command | Purpose |
| --- | --- |
| `/pbot init` | Enable the workspace and create missing material directories and root `AGENTS.md` |
| `/pbot status` | Inspect activation, workspace, and version |
| `/pbot enter [agent]` | Attach to an owned Pi native specialist's tmux session to view its transcript |
| `/reload` | Pi's native command to reload extensions and resources |

- **Initialization and materials:** `/pbot init` creates missing materials and enables the workspace, preserving existing materials and other configuration fields. Pi reloads on first activation; an already running workspace loads a newly created root AGENTS after `/reload`.
- **Native tools:** Use CLI tools through Bash and MCP through the host's configuration. Add Pi project connections with `pi mcp add --local <server> ...` and inspect their source with `/mcp`. See the [connection skill](resources/skills/provider-connections/SKILL.md).
- **History:** Pi/dsh refresh and summarize their own sources and query all existing archives, including preserved Claude archives. Originals are searchable first; after a main interaction, the current model fills pending summaries through additional model calls. New input cancels that work first. Claude uses native session history. See [history](docs/history.md).
- **Specialists and teams:** Default Pi specialists require tmux; dsh uses native sessions. Pi/dsh pbot teams support ordered discussions and parallel rounds; pause and drain their work before private tasks. Claude uses native Agent and native team tools. Pi/dsh ACP calls Pi, dsh, and Claude Code for independent conversations, reports, and explicit restoration. ACP model and thinking are independently optional; omitted values use the target host defaults. See [specialist collaboration](docs/agent-collaboration.md).
- **Calculations:** Use native Bash with the project's interpreter, dependencies, and working directory. The [Python calculation reference](resources/references/compute.md) covers common methods; [indicators and backtesting](resources/references/compute-finance.md) covers financial calculations. Install the tools and libraries required by the project in its chosen environment.
- **Material maintenance:** Ask the assistant to organize a project, repeat an analysis with its existing definitions, or check a delivery. The [maintenance skill](resources/skills/project-maintenance/SKILL.md) updates current guidance and extracts reusable methods while preserving formal materials, history, and backups.

Use `pi --resume` to select the main session explicitly; `pi --continue` can select the most recently active child. Enter owned Pi native specialists through `/pbot enter [agent]`; use `pbot_agent resume` with a new instruction to continue a stopped specialist. Keep one writer per running session.

## Workspace materials

| Location | Purpose |
| --- | --- |
| `.pbot/config.json` | Shared workspace activation and open ACP target configuration |
| `AGENTS.md` | Project index, links to materials, working agreements, and optional harness routing preferences |
| `areas/`, `projects/` | Long-term goals, tasks, conclusions, and deliverables |
| `knowledge/` | Reusable concepts, methods, and analysis definitions |
| `.pbot/history/` | Pi/dsh original exchanges in `raw/` and derived summaries in `summary/`; preserved Claude archives |
| `providers/` | External tool guidance, data definitions, and sources |
| `scratch/` | Temporary scripts, calculation data, downloads, and environments |
| `agents/` | Role additions |
| `.agents/skills/` (Pi/dsh/Antigravity), `.claude/skills/` (Claude) | Workspace skills discovered by the current host |

Existing layouts and agreements take precedence. Fetch queryable data when needed using the recorded definitions. Stop writes in the old instance before copying a workspace; concurrent writes from multiple machines to a synchronized directory are unsupported. See [file storage](docs/file-storage.md).

## Updates and operating scope

Current release: **0.2.20**. Update through the host's native package manager. For a local Pi source, update the checkout, run `npm ci --ignore-scripts` when dependencies change, then reload or restart. Stop active specialists before changing versions. Recreate specialists across compatibility lines; existing materials, history, and backups are preserved.

Operations follow the user's request, existing agreements, and required confirmations. Bash, Python, MCP, and extensions use the actual account and credential permissions. Enforce hard limits through read-only credentials, service controls, or restricted environments. Trades, transfers, and ledger changes require authorization for those operations. After cancellation, timeout, or disconnection, query native status before retrying to avoid duplicate execution.

Task Conductor nodes need their own tools, environment, skills, and authentication. Preserve human interaction for operations that require confirmation. See [tools and execution](docs/capability-design.md).

## Development and documentation

Development and complete acceptance for all three hosts use Linux and Node.js 24.9+. After installing locked dependencies, run:

```bash
npm run check
npm test
git diff --check
npm pack --dry-run
```

`npm test` builds `dist/` for tests and `lib/` for distribution and runs local Pi/dsh checks plus Claude Node hook-process tests. Pi loads source at runtime. Claude package checks install the actual tarball, run native plugin validation, and exercise hooks/CLI without models or host SDKs. Real-model ACP and Claude context, skills, and specialist validation run separately in explicitly approved environments with dedicated authentication. See [release checks](docs/release.md).

- [Documentation index](docs/README.md): current architecture, usage, and development guidance.
- [npm release](docs/release.md): candidate checks, configuration, and publication.
- [Domain terms](CONTEXT.md).
