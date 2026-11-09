# Personal Bot

English | [简体中文](README.zh-CN.md)

**A personal assistant connecting knowledge, research, and action.**

Personal Bot provides a workspace-scoped [Pi](https://pi.dev) extension and a native dsh Web integration for organizing materials, project work, research, specialist collaboration, and authorized operations. The model handles analysis and coordination; the plugin adds workspace materials, specialist sessions, history search, and a shared Python environment.

## Enable a workspace

After installation, open Pi or dsh in the target workspace and run `/pbot init` to initialize and enable it. Pi and dsh share the `.pbot/config.json` created by this command:

```json
{ "enabled": true }
```

A missing file or false leaves Personal Bot inactive, without packaged skills or pbot prompts, and directs the user to `init`. Pi's status bar and the dsh workspace page show the runtime state; `/pbot status` remains available. After manual configuration edits, use `/reload` in Pi or restart dsh. See [workspace configuration](docs/workspace-configuration.md) (Chinese).

## Install

### Pi setup wizard

Linux and macOS require Node.js 22.19+, npm, and Python 3.11+ with venv/ensurepip. Run in an interactive terminal:

```bash
npx personal-bot@latest setup
# Or select the workspace directly
npx personal-bot@latest setup --workspace ~/pbot-workspace
```

The wizard selects or creates a directory, installs or updates Pi, and installs Personal Bot for that workspace. Task Conductor and Pi Web Access are selected by default on the first installation; later runs preselect installed plugins. Ordinary npm sources update to the latest stable version. Local, Git, and pinned sources are kept by default, with an option to switch. Deselecting a plugin preserves its installation.

Missing tmux is installed through an existing Homebrew or supported Linux package manager. Missing Python prerequisites produce repair instructions. After installation, the wizard can start Pi and run `/pbot init`. Follow Pi's prompts for project trust, login, and model selection.

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

You need Node.js 24.9+, npm, pnpm, and Python 3.11+. Follow the installed dsh release's `engines` if it requires a newer runtime. Use its native profiles and plugin manager:

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

### Use from source

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm run build:cli
node bin/pbot.mjs setup
```

To load only the Pi source extension, run `pi install --local /absolute/path/to/personal-bot` from the workspace and keep that source directory and its dependencies available. For dsh, follow the [source installation steps](docs/dsh.md#从源码安装) (Chinese).

### Optional: Task Conductor

Use `task-conductor-plugin` for schedules, recurring workflows, DAGs, and tasks that continue after the host exits. Install the plugin and its service separately, following the [upstream integration guide](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md).

Pi users run `pi install --local npm:task-conductor-plugin` from the workspace, reload, then read `/skill:using-task-conductor`. dsh users follow the [Task Conductor setup](docs/dsh.md#task-conductor) (Chinese) and read `/using-task-conductor` in the main session.

Notifications return to the session that submitted the task. Service tasks continue after Pi or dsh closes. Query and stop the current run and future recurrences separately.

## Daily use

Describe the task directly: organize materials, compare findings, delegate a review, or run calculations. These commands are for Pi; dsh commands are in its guide.

| Command | Purpose |
| --- | --- |
| `/pbot` | Open the workspace menu |
| `/pbot init` | Enable the workspace and create missing material directories and root `AGENTS.md` |
| `/pbot status` | Inspect activation, workspace, version, and Python state |
| `/pbot history [text]` | Search exchanges and summaries, then read originals |
| `/pbot agents` | Inspect, enter, rename, stop, or send instructions to specialists |
| `/pbot teams` | Inspect teams and public messages; start rounds, pause, or close |
| `/pbot python setup` | Retry shared Python preparation |
| `/reload` | Pi's native command to reload extensions and resources |

- **Initialization and materials:** `/pbot init` creates missing materials and enables the workspace, preserving existing materials and other configuration fields. Pi reloads on first activation; an already running workspace loads a newly created root AGENTS after `/reload`.
- **Native tools:** Use CLI tools through Bash and MCP through the host's configuration. Add Pi project connections with `pi mcp add --local <server> ...` and inspect their source with `/mcp`. See the [connection skill](resources/skills/provider-connections/SKILL.md).
- **History:** Pi and dsh query shared workspace archives. Originals are searchable first; after a main interaction, the current model fills pending summaries through additional model calls. New input cancels that work first. See [history](docs/history.md).
- **Specialists and teams:** Delegate independent work, continue a conversation, or organize ordered discussions and parallel rounds. Pi specialists require tmux; dsh uses native sessions. A running team reserves its members. Pause and drain in-flight work before private tasks. See [specialist collaboration](docs/agent-collaboration.md).
- **Python:** Enabled workspaces share one venv for the current user. Workspace activation prepares it and activates it in the host process. Use `python` or `python3` through Bash. Stop scripts using the environment before dependency updates. See the [Python guide](python/README.md) for paths, troubleshooting, and licenses.
- **Material maintenance:** Ask the assistant to organize a project, repeat an analysis with its existing definitions, or check a delivery. The [maintenance skill](resources/skills/project-maintenance/SKILL.md) updates current guidance and extracts reusable methods while preserving formal materials, history, and backups.

Use `pi --resume` to select the main session explicitly; `pi --continue` can select the most recently active child. Enter managed specialists through `/pbot agents`. Opening a stopped specialist's saved session leaves it idle; use resume with a new instruction to continue work. Keep one writer per running session.

## Workspace materials

| Location | Purpose |
| --- | --- |
| `.pbot/config.json` | Shared Pi/dsh workspace activation and configuration |
| `AGENTS.md` | Navigation and working agreements |
| `areas/`, `projects/` | Long-term goals, tasks, conclusions, and deliverables |
| `knowledge/` | Reusable concepts, methods, and analysis definitions |
| `.pbot/history/` | Pi/dsh exchanges, summaries, and node links |
| `providers/` | External tool guidance, data definitions, and sources |
| `scratch/` | Temporary scripts, calculation data, downloads, and environments |
| `agents/`, `.agents/skills/` | Role additions and workspace skills |

Existing layouts and agreements take precedence. Fetch queryable data when needed using the recorded definitions. Stop writes in the old instance before copying a workspace; concurrent writes from multiple machines to a synchronized directory are unsupported. See [file storage](docs/file-storage.md).

## Updates and operating scope

Current release: **0.2.11**. Update through the host's native package manager. For a local Pi source, update the checkout, run `npm ci --ignore-scripts` when dependencies change, then reload or restart. Stop active specialists before changing versions. Recreate specialists across compatibility lines; existing materials, history, and backups are preserved.

Operations follow the user's request, existing agreements, and required confirmations. Bash, Python, MCP, and extensions use the actual account and credential permissions. Enforce hard limits through read-only credentials, service controls, or restricted environments. Trades, transfers, and ledger changes require authorization for those operations. After cancellation, timeout, or disconnection, query native status before retrying to avoid duplicate execution.

Task Conductor nodes need their own tools, environment, skills, and authentication. Preserve human interaction for operations that require confirmation. See [tools and execution](docs/capability-design.md).

## Development and documentation

Development for both hosts uses Linux and Node.js 24.9+. After installing locked dependencies, run:

```bash
npm run check
npm test
git diff --check
npm pack --dry-run
```

`npm test` includes smoke and E2E tests and generates `dist/` for tests and `lib/` for distribution. Pi loads source at runtime.

- [Documentation index](docs/README.md): current architecture, usage, and development guidance.
- [npm release](docs/release.md): candidate checks, configuration, and publication.
- [Domain terms](CONTEXT.md).
