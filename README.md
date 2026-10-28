# Personal Bot

English | [简体中文](README.zh-CN.md)

**A personal assistant connecting knowledge, research, and action.**

Personal Bot is currently a workspace-scoped [Pi](https://pi.dev) extension for learning, project work, research, and decision support, including investment analysis and explicitly authorized operations.

The model handles analysis, coordination, and native tools. Personal Bot adds workspace materials, specialist collaboration, and Python environment preparation. It does not create a second main agent or start tasks or trades automatically.

## Install

Requirements: Linux, Node.js 22.19+, and Pi with a configured model and authentication. Python computation requires Python 3.11+. Development and local tests currently use Pi 1.4.0; other host versions need separate validation. Native MCP and the optional Task Conductor integration require Pi 1.4.0+.

From your workspace root:

```bash
pi install --local npm:personal-bot
pi
```

`--local` saves the package declaration in the project's `.pi/settings.json`. Review and grant project trust when Pi prompts you, and start Pi from the workspace root. Loading Personal Bot enables its roles, skills, tools, and shared Python environment preparation. There is no separate activation switch.

Avoid a global installation unless you want Personal Bot in every Pi session. Use Pi package management or `pi config` to adjust an existing installation's scope. Do not load both the npm and source installations.

### Install from source

For development:

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
cd /path/to/workspace
pi install --local /absolute/path/to/personal-bot
pi
```

Replace the example paths with your actual paths. A local installation loads the source directory directly, so keep that directory and its dependencies available.

### Optional: Task Conductor

For scheduled tasks, recurring workflows, or DAGs, install `task-conductor-plugin`. This integration package is distinct from the `task-conductor` service and is not required for Personal Bot. It requires Pi 1.4.0+ with native MCP support and npm.

Check `pi list` first. If the package is already installed but its skill is missing, check resource configuration and reload rather than installing it again. Review the [upstream integration guide](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md), then run from the workspace root:

```bash
pi install --local npm:task-conductor-plugin
```

In Pi, run `/reload`, then `/skill:using-task-conductor`. With your confirmation, the skill guides service installation, `task-conductor setup`, and native MCP configuration. Installing the plugin alone does not install the service. Keep credentials in your terminal or private files, not in chat.

For an older integration package, check its source and scope with `pi list`, review upstream upgrade instructions, and explicitly remove the old declaration before installing its replacement. Update the plugin and service separately. Before a service upgrade, check active tasks, stop the service, and back up its data. Follow upstream MCP instructions; do not automatically migrate configuration or delete history.

`--local` limits plugin loading, not service data access. Choose MCP configuration scope separately, and keep existing connections without duplicate registration. Use `/mcp` or `pi mcp list` to check actual tools, then follow the skill's read-only validation steps. Do not create model tasks just to test installation. A working connection does not prove model authentication or task delivery.

## Optional workspace preparation

Personal Bot works without initialization. Run `/pbot init` only if you want the standard material layout. It creates missing material directories and a missing root `AGENTS.md`; it does not overwrite files or start model tasks. Activation does not depend on confirmation or reload after initialization.

Keep goals, markets, preferences, and working agreements in ordinary documents. Ask the assistant to organize them as needed. For external tools, provide the CLI/MCP name, purpose, official documentation, or configuration location—not credential values.

## Daily use

Describe the task directly: organize project materials, compare research findings, delegate an independent review, or run calculations. No fixed workflow is required.

| Command | Purpose |
| --- | --- |
| `/pbot init` | Create missing material directories and root `AGENTS.md` |
| `/pbot status` | Show workspace path, Personal Bot version, and Python environment status |
| `/pbot agents` | Inspect specialists; enter sessions, send instructions, rename, or stop tasks |
| `/pbot teams` | Inspect teams and public messages; start rounds, pause, close, or open members |
| `/pbot python setup` | Retry shared venv preparation and activation; no path argument needed |
| `/reload` | Pi's native command to reload extensions and resources |

- **Native tools:** Use CLI commands through Bash with their current help. Keep concise provider guides and evidence references. Configure MCP for the current project by default: run `pi mcp add --local <server> ...` from the workspace root to write `.pi/mcp.json`, then inspect the configuration source with `/mcp`. Change user-level configuration only when cross-project use is explicitly requested. No Personal Bot registration, parameter binding, or permission table is needed. See the [connection skill](resources/skills/provider-connections/SKILL.md).
- **Research and analysis:** Ask the assistant to synthesize evidence, explain conflicts, check calculations and definitions, or identify assumptions to validate first. It uses the [research evidence](resources/skills/research-evidence/SKILL.md) and [analysis validation](resources/skills/analysis-validation/SKILL.md) skills as needed, with conclusions and limitations tied to the task.
- **Independent sub-sessions:** Personal Bot supports tmux and independent Pi sessions; install tmux on the system to use them. `pbot_agent start` returns immediately; without a message, prompts, or files it creates an idle process without calling a model. Task completion produces a notification. Options cover models, directories, files, tools, and resources. Operations include send, follow-up, rename, status, read, stop, and explicit resume; there is no foreground/background flag or wait operation. `/pbot agents` shows active agents and can open their TUI. Main-session reload preserves running agents; exit or session switching stops them and retains history. Sub-sessions use native CLI/MCP within their delegated scope. See [specialist collaboration](docs/agent-collaboration.md).
- **Teams:** `pbot_team` groups existing agents for `roundRobin` discussion or `parallel` rounds. Members exchange original messages through `pbot_team_message`; ordinary posts do not wake models. A running team reserves its members. Pause and drain in-flight work before private messages; reload pauses teams without replaying requests. The first release uses fixed membership and bounded rounds, not dynamic ask/reply wake-ups. See [specialist collaboration](docs/agent-collaboration.md).
- **Scheduled and durable tasks:** The main session uses optional Task Conductor directly through native MCP, its `using-task-conductor` skill, and actual tool contracts. Without it, ordinary Personal Bot features still work, but scheduling is unavailable. Personal Bot adds no durable task scheduler or forwarding layer. Query and stop external tasks separately from sub-sessions. Cancelling the current run does not stop future recurrences, and closing Pi does not imply that external tasks stopped.
- **Python:** All workspaces share one dedicated venv for the current user. Loading Personal Bot creates or updates it with locked dependencies and activates it in the current Pi process. Main and specialist sessions use `python` or `python3` through Bash. Failures are reported; fix the cause and retry with `/pbot python setup`. System Python, external terminals, existing scripts, and historical results are not changed. Shared dependency updates affect other workspaces, so stop relevant scripts before changing plugin versions or retrying setup. See the [Python guide](python/README.md) and [computation reference](resources/references/compute.md).
- **Material maintenance:** Ask to organize project materials, reproduce a report using its previous definitions, or review delivery and close a task. The [project maintenance skill](resources/skills/project-maintenance/SKILL.md) updates the current task and affected materials within your requested scope. Current guidance is consolidated by topic; conclusions, conditions, task definitions, historical evidence, and important decisions remain traceable. Cleanup removes unnecessary temporary outputs within scope, not formal materials, history, or backups.

Main and child transcripts use Pi's native session storage. Use `pi --resume` to select a chat explicitly; `pi --continue` may select the most recently active child. Enter managed children through `/pbot agents`; stopped children reopen their saved session idle, without calling a model. Use `pbot_agent resume` to restart with a new instruction. Never open a second writer for a running child's session file. Do not resend a potentially side-effecting operation merely because a session resumed.

Personal Bot maintains no separate provider-call ledger or result wrapper. Native tools own their results and large-output handling; save formal evidence with the task. If an outcome is unclear, query native status first. Complete result retention is not guaranteed after a process crash.

## Workspace materials

| Location | Purpose |
| --- | --- |
| `AGENTS.md` | Material navigation and working agreements |
| `areas/`, `projects/` | Long-term goals, task definitions, conclusions, and evidence |
| `knowledge/` | Reusable knowledge |
| `providers/` | Provider guides, coverage gaps, and validation evidence |
| `scratch/` | Temporary calculations and reproducible outputs |
| `agents/`, `.agents/skills/` | Workspace additions to coordinator/general-purpose roles and workspace skills |

Personal Bot stores no private activation state in the workspace. Pi owns its configuration; reload when required by Pi. Stop the old instance before copying a workspace. Concurrent writes from multiple machines to a synchronized directory are not supported. See [file storage](docs/file-storage.md) for storage and copying boundaries.

## Updates and historical data

Current release: **0.2.0**. Personal Bot maintains no workspace format, initialization state, or workspace upgrade mechanism. Update the plugin through Pi package management. For a local installation, update the source, run `npm ci --ignore-scripts` if dependencies changed, then reload or restart Pi.

Stop active sub-sessions before changing versions. Sub-session compatibility follows the minor version before 1.0 and the major version from 1.0 onward. Sessions from another compatibility line cannot be resumed directly.

Pi stores child JSONL transcripts in its native session directory or the location selected by native configuration. In the current Pi agent directory, `pbot/subagents/` holds only control records and session references; `pbot/teams/` holds public team records. Version 0.2.0 does not support the old session location. It does not migrate or delete 0.1.x history, and excludes old records from current lists and background scheduling. Stop active children with the old version before updating, then create new agents. The shared Python environment uses the user-level `pbot/python/.venv`; see the [Python guide](python/README.md) for exact system paths. Personal Bot does not import other applications' sessions, configuration, or environments, or modify their data. Configure MCP and CLI environments explicitly through native mechanisms. Preserve user materials, historical evidence, and backups.

## Trust and risks

- Personal Bot provides no per-tool permission system or unified approval gate. CLI, MCP, Bash, Python, and extensions have the permissions of their actual accounts and credentials. They are not sandboxed. Use read-only credentials, service-side controls, or a restricted environment for hard limits.
- Tool availability is not user authorization. Research, connection setup, and validation do not authorize trades, transfers, or ledger changes.
- Protocol success does not prove business completion. Cancellation, timeout, and session recovery do not undo external side effects. Check native status before retrying an operation that may have been sent.
- Task Conductor nodes do not automatically inherit the main session's tools, environment, or skills. Do not schedule unattended operations without user authorization or when the native service requires human confirmation.

See [native tools and execution boundaries](docs/capability-design.md). Real models, external services, and full TUI/RPC interactions still require an approved acceptance environment. Local tests do not prove readiness for live trading.

## Development and documentation

```bash
npm run check
npm test
git diff --check
```

`npm test` includes smoke and E2E tests and generates `dist/` for test imports. Runtime loading uses source files directly. Inspect package contents with `npm pack --dry-run`. See [validation](docs/validation.md) for test groups and limits.

The README is available in English and Simplified Chinese. Detailed design documents and bundled guides are currently primarily in Chinese.

- [Development documentation](docs/README.md): architecture, tools, collaboration, storage, and validation.
- [npm releases](docs/release.md): configuration, authorization, publishing, and installation acceptance.
- [Domain terminology](CONTEXT.md) · [Python environment, native libraries, and licenses](python/README.md).
