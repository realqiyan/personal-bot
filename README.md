# Personal Bot

English | [简体中文](README.zh-CN.md)

**A personal assistant connecting knowledge, research, and action.**

Personal Bot provides a workspace-scoped [Pi](https://pi.dev) extension, a native dsh Web integration, and a standard Claude Code plugin. It supports organizing materials, project work, research, specialist collaboration, and authorized operations. Pi/dsh add managed specialists, teams, and history search. Claude uses native skills, Agent/teams, and Node command hooks. All three share workspace materials and professional methods.

Claude's model-driven context, skills, and specialist behavior still need validation in an approved native model environment. See the [Claude Code guide](docs/claude-code.md) (Chinese) for operations.

## Enable a workspace

After installation, open the host in the target workspace. Pi/dsh use `/pbot init`; Claude uses the native skill `/personal-bot:pbot init`. These initialize materials and enable the shared `.pbot/config.json`:

```json
{ "enabled": true }
```

A missing, disabled, or invalid config leaves Personal Bot inactive; only the current workspace root is checked, with no automatic configuration migration. Pi/dsh withhold packaged skills and pbot prompts. Claude can display static skill names and descriptions; its hooks block work methods invoked through Skill or direct slash commands while leaving the pbot initialization skill available. Inspect state with Pi/dsh `/pbot status` or Claude `/personal-bot:pbot status`. After manual edits, use `/reload` in Pi or restart dsh; Claude reads current configuration at its hooks and CLI operations, with the root fixed by `CLAUDE_PROJECT_DIR`. See [workspace configuration](docs/workspace-configuration.md) (Chinese).

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

### Optional: ACP specialist programs

Pi/dsh use ACP to delegate independent work to Pi, dsh, or Claude. Install each target you need on the machine running the main host:

| Target | Installation | Authentication and model |
| --- | --- | --- |
| Pi | With Pi installed, run `npm install -g pi-acp`. Install Pi itself with `npm install -g @earendil-works/pi-coding-agent` if needed. | Run `pi` to sign in and select a default model. |
| dsh | An existing command-line dsh installation is sufficient; otherwise run `npm install -g @deepseek-ai/dsh@latest`. | Configure the target profile's model and authentication through dsh. The default entry is `dsh --profile acp`. |
| Claude Code | `npm install -g @agentclientprotocol/claude-agent-acp` | Follow the [Claude Code guide](https://code.claude.com/docs/en/quickstart) to sign in or configure API access, then set a default model. |

Check the target from the same terminal that starts your main host, for example with `command -v claude-agent-acp`. Retry the original start request after installation. If the program is installed but absent from the host's PATH, put its absolute path in the workspace [acp configuration](docs/workspace-configuration.md#acp-启动配置) (Chinese). Restart the main host after PATH changes. For workspace ACP configuration changes, run `/reload` in Pi or restart dsh.

When a program is missing, the tool returns its installation command, authentication guidance, and a path configuration example. See [ACP members](docs/agent-collaboration.md#acp-成员) (Chinese) for calls and continued conversations.

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
| `/pbot` | Open the workspace menu |
| `/pbot init` | Enable the workspace and create missing material directories and root `AGENTS.md` |
| `/pbot status` | Inspect activation, workspace, and version |
| `/pbot history [text]` | Search exchanges and summaries, then read originals |
| `/pbot agents` | Inspect, enter, rename, stop, or send instructions to specialists |
| `/pbot teams` | Inspect teams and public messages; start rounds, pause, or close |
| `/reload` | Pi's native command to reload extensions and resources |

- **Initialization and materials:** `/pbot init` creates missing materials and enables the workspace, preserving existing materials and other configuration fields. Pi reloads on first activation; an already running workspace loads a newly created root AGENTS after `/reload`.
- **Native tools:** Use CLI tools through Bash and MCP through the host's configuration. Add Pi project connections with `pi mcp add --local <server> ...` and inspect their source with `/mcp`. See the [connection skill](resources/skills/provider-connections/SKILL.md).
- **History:** Pi/dsh refresh and summarize their own sources and query all existing archives, including preserved Claude archives. Originals are searchable first; after a main interaction, the current model fills pending summaries through additional model calls. New input cancels that work first. Claude uses native session history. See [history](docs/history.md).
- **Specialists and teams:** Default Pi specialists require tmux; dsh uses native sessions. Pi/dsh pbot teams support ordered discussions and parallel rounds; pause and drain their work before private tasks. Claude uses native Agent and native team tools. Pi/dsh ACP calls Pi, dsh, and Claude Code for independent conversations, reports, and explicit restoration. ACP model and thinking are independently optional; omitted values use the target host defaults. See [specialist collaboration](docs/agent-collaboration.md).
- **Calculations:** Use native Bash with the project's interpreter, dependencies, and working directory. The [Python calculation reference](resources/references/compute.md) covers common methods; [indicators and backtesting](resources/references/compute-finance.md) covers financial calculations. Install the tools and libraries required by the project in its chosen environment.
- **Material maintenance:** Ask the assistant to organize a project, repeat an analysis with its existing definitions, or check a delivery. The [maintenance skill](resources/skills/project-maintenance/SKILL.md) updates current guidance and extracts reusable methods while preserving formal materials, history, and backups.

Use `pi --resume` to select the main session explicitly; `pi --continue` can select the most recently active child. Enter managed specialists through `/pbot agents`. Opening a stopped specialist's saved session leaves it idle; use resume with a new instruction to continue work. Keep one writer per running session.

## Workspace materials

| Location | Purpose |
| --- | --- |
| `.pbot/config.json` | Shared Pi/dsh/Claude workspace activation and configuration |
| `AGENTS.md` | Navigation and working agreements |
| `areas/`, `projects/` | Long-term goals, tasks, conclusions, and deliverables |
| `knowledge/` | Reusable concepts, methods, and analysis definitions |
| `.pbot/history/` | Pi/dsh exchanges, summaries, and node links; preserved Claude archives |
| `providers/` | External tool guidance, data definitions, and sources |
| `scratch/` | Temporary scripts, calculation data, downloads, and environments |
| `agents/` | Role additions |
| `.agents/skills/` (Pi/dsh), `.claude/skills/` (Claude) | Workspace skills discovered by the current host |

Existing layouts and agreements take precedence. Fetch queryable data when needed using the recorded definitions. Stop writes in the old instance before copying a workspace; concurrent writes from multiple machines to a synchronized directory are unsupported. See [file storage](docs/file-storage.md).

## Updates and operating scope

Current release: **0.2.15**. Update through the host's native package manager. For a local Pi source, update the checkout, run `npm ci --ignore-scripts` when dependencies change, then reload or restart. Stop active specialists before changing versions. Recreate specialists across compatibility lines; existing materials, history, and backups are preserved.

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
