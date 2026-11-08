# Using Personal Bot with dsh

English | [简体中文](dsh.md)

Personal Bot uses dsh's native Web interface for workspace materials, specialists, teams, history, and Python preparation. Pi and dsh share materials, roles, methods, and collaboration rules while owning their own native sessions, model settings, authentication, and MCP configuration.

Install and update with the latest dsh release. The minimum host version is `0.2.2-rc.1`. This guide separates terminal commands from `/pbot` chat commands; consult the installed version's help after updates.

## Installation and first start: CLI and browser

You need Node.js 24.9+, npm, pnpm, and Python 3.11+ with venv/ensurepip. Follow dsh's engines if a newer release raises its runtime requirement. Install through native profiles and plugin management:

```bash
npm view @deepseek-ai/dsh@latest version engines --json
npm install -g @deepseek-ai/dsh@latest pnpm@latest
# First creation only; this replaces an existing profile of the same name.
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

`pbot` is a profile name you choose; use it consistently. Do not repeat `--from-default-profile` when updating an existing profile.

dsh starts the Web server and normally opens a browser. Over SSH or with `--no-open`, open the printed URL yourself; keep its access token private. Select a workspace and main session, configure models and authentication, then enter in chat:

```text
/pbot status
/pbot init
/pbot
```

`status` inspects state; optional `init` creates missing material directories and root AGENTS while preserving existing files; bare `/pbot` opens management. Loading the plugin prepares the user's shared Python venv. If preparation fails, repair the prerequisites and run `/pbot python setup`.

One profile can manage multiple workspaces. Choose a directory through the native workspace picker; the default is the system Documents directory. pbot binds to the root at main-session creation. Later cwd changes affect relative path resolution.

## Daily startup and terminal commands

Start an existing profile directly. Use `Ctrl+C` in its foreground terminal to stop the server:

```bash
dsh --profile pbot
# Choose a port without opening a browser automatically.
dsh --profile pbot --port 8080 --no-open
```

Place launcher options before Web options. The configuration inspection commands below are for an existing profile. Do not add `--from-default-profile` unless you intend to recreate it.

| Command | Purpose |
| --- | --- |
| `dsh --version` / `dsh -V` | Show the actual host version |
| `dsh --help` | Show launcher help |
| `dsh --profile pbot --help` | Show the profile's Web options |
| `dsh plugin --help` | Show the plugin command entry's help |
| `dsh --profile pbot` / `dsh pbot` | Start an existing profile |
| `dsh --profile pbot --dump-config` | Print the composed configuration and exit without starting the server |
| `dsh --profile pbot --dump-default-config` | Print bundle configuration without user overrides or command-line patches |
| `dsh --profile pbot --dump-config-schema` | Import plugin schemas and print the configuration structure without starting the server; use with trusted plugins |
| `dsh --profile pbot --patch /absolute/path/extra.yml` | Apply an additional patch for this invocation; repeatable, before Web options |

The three `--dump-*` options are mutually exclusive. Configuration output may contain private settings. Native profiles belong to dsh; they are not pbot workspace files.

| Web option | Purpose |
| --- | --- |
| `--port 8080` | Choose a port; the default is 3080, and `--port 0` lets the OS choose a free port |
| `--no-open` | Start the server without opening a browser |
| `--host 127.0.0.1` | Bind one concrete local IPv4/IPv6 address; defaults to loopback and rejects wildcard addresses such as `0.0.0.0` and `::` |
| `--public-url https://app.example/` | Advertise a public URL; does not configure a proxy or grant access |
| `--trusted-host app.example` | Add a hostname or host:port accepted by the native Host/Origin check |
| `--tls-cert /path/server-chain.pem --tls-key /path/server-key.pem` | Supply a certificate chain and unencrypted PEM private key together to enable listener HTTPS |

For proxy, network access, and authentication settings, see the [native dsh Web documentation](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/bundle/web-app).

## Updating, inspecting, and removing plugins

Update the host, pnpm, and profile plugins separately. First pause teams, let in-flight work finish, and stop active specialists. Stop the corresponding server with `Ctrl+C`, then run:

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
dsh plugin --profile pbot update personal-bot --latest
dsh --version
pnpm --version
dsh plugin --profile pbot list personal-bot --depth 0
dsh --profile pbot
```

`update personal-bot --latest` selects only Personal Bot for an update to the current `latest`, even when that is outside the saved version range. Without `--latest`, update respects the existing declaration. After updating, check the version and environment with `/pbot status`. Previous specialists need explicit resumption. Disabling or reloading the plugin can also release specialists.

Package arguments after `dsh plugin --profile pbot` are forwarded to pnpm. Select the correct profile:

| Command | Purpose |
| --- | --- |
| `dsh plugin --profile pbot list --depth 0` | List the profile's direct dependencies |
| `dsh plugin --profile pbot list personal-bot --depth 0` | Show the installed Personal Bot version |
| `dsh plugin --profile pbot outdated personal-bot` | Check available updates; finding an outdated package can produce a nonzero exit code |
| `dsh plugin --profile pbot why personal-bot` | Show why the dependency is installed |
| `dsh plugin --profile pbot add personal-bot@latest` | Install Personal Bot from the registry |
| `dsh plugin --profile pbot update personal-bot --latest` | Update this plugin |
| `dsh plugin --profile pbot remove personal-bot` | Remove the plugin from this profile after stopping its work; preserve workspaces and history |
| `dsh plugin --profile pbot version-exemptions` | List the profile's saved native compatibility exemptions |

Use the native Plugins page to disable or enable a plugin temporarily and to manage desktop installations. Plugin changes affect sessions sharing the profile. If compatibility is rejected, first check `dsh --version`, the installed package version, and release notes. Compatibility exemptions are not a routine upgrade step. Exact-version `allow-version` / `revoke-version` operations are documented in the [native compatibility reference](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/boot/plugin-manager#version-compatibility-and-exemptions).

## Installing from source

For development or acceptance, generate a tarball containing the CLI, Host, and Web artifacts from the repository:

```bash
git clone https://github.com/realqiyan/personal-bot.git
cd personal-bot
npm ci --ignore-scripts
npm pack
```

`npm pack` runs the checks and builds through prepack. Install the actual artifact's absolute path into an existing Web profile:

```bash
dsh plugin --profile pbot add /absolute/path/to/personal-bot-<version>.tgz
dsh --profile pbot
```

Rebuild and install a new tarball to update a local source. To switch to the registry, run `dsh plugin --profile pbot add personal-bot@latest`.

## Desktop application

In DeepSeek Harness, install and enable `personal-bot@latest` through **Plugins → Add plugin**, or enter an absolute local tarball path. Desktop provides its runtime and package manager. Update the host and plugins through the application.

Desktop uses its own desktop profile, separate from the CLI's pbot profile. It reads the login shell environment, where Python 3.11+ must be on PATH. After installation, select a workspace and main session and inspect the environment with `/pbot status`.

## Task Conductor

Use optional `task-conductor-plugin` for schedules, recurring workflows, and DAGs. Install the plugin and service separately; configuration and updates follow the [upstream integration guide](https://github.com/realqiyan/task-conductor/blob/master/docs/host-integrations.md).

The dsh integration is part of the unpublished Task Conductor 0.1.6 candidate. Until publication, build the plugin and service from the same source:

```bash
cd /absolute/path/to/task-conductor
npm ci --ignore-scripts
npm pack
npm run pack:plugin
```

Install using the actual generated tarball paths:

```bash
dsh plugin --profile pbot add /absolute/path/to/task-conductor-plugin-<version>.tgz
npm install -g /absolute/path/to/task-conductor-<version>.tgz
task-conductor setup
```

For an existing service, follow the [upstream upgrade steps](https://github.com/realqiyan/task-conductor/blob/master/docs/upgrades.md) and preserve its service directory and data. Desktop users install the same plugin tarball through the application's Plugins page.

Restart the host and read `/using-task-conductor` in the main session. Use `/task-conductor status` to inspect the connection and `/task-conductor connect` after configuration repairs. The plugin creates a native MCP connection; adjust any existing connection with the same name through the upstream guide.

Notifications return to the session that submitted the task. Service tasks continue when pages or hosts close. Query and stop the current run and future recurrences separately.

To execute nodes with dsh, follow the upstream [custom ACP instructions](https://github.com/realqiyan/task-conductor/blob/master/plugin/skills/using-task-conductor/references/custom-acp.md). Register `dsh-acp` with dsh's canonical absolute executable path and `["--profile", "acp"]` arguments. Configure node models, tools, authentication, and Python separately.

## Management interface and lifecycle

Select the bare `/pbot` action in the native input to open four tabs:

| Tab | Operations |
| --- | --- |
| Workspace | Source, directory, model, Python, and history preparation state; prepare materials or retry Python |
| Specialists | Create, rename, stop, explicitly resume; human chat, attachments, and full native records |
| Teams | Fixed members and roles, bounded rounds, pause, close, public originals, and long-message paging |
| History | Filter Pi/dsh archives and dates, read exchanges and summaries, and navigate parents and children |

Wide windows use side navigation; narrow windows use top navigation. Specialists can be filtered by name or state. Drafts and attachments are retained per specialist, and team drafts are retained separately.

Pages query native Remotes without starting specialists, acknowledging model notifications, or generating summaries. Human commands retain native audit records. Closing the panel cancels uploads not yet accepted. Closing, refreshing, or reconnecting a page does not stop accepted work. If an outcome is unclear, inspect status and records before taking further action.

Disabling the server component, releasing its parent Agent, or fully quitting Desktop pauses scheduling and releases the specialists it owns. Reopening a page, restarting the host, or enabling the plugin reads saved records; continuing work requires explicit resumption.

The main session needs a one-time native approval for write, edit, or apply_patch outside the original workspace. Those tools reject such changes from specialists. Bash, Python, MCP, and extensions use actual account permissions; see [tools and execution](capability-design.md).

## Chat command reference

Enter these commands in dsh chat, not in a terminal. JSON must be one object with double-quoted property names. Replace `AGENT_ID`, `TEAM_ID`, and `NODE_ID` with actual returned IDs. Apart from the bare `/pbot` Web action, commands return JSON text.

| Command | Purpose |
| --- | --- |
| `/pbot` | Open management in Web; direct server execution without arguments returns status |
| `/pbot status` | Inspect workspace, release, model, Python, history, specialists, and teams |
| `/pbot init` | Optionally create missing material directories and a missing root `AGENTS.md` |
| `/pbot python setup` | Retry shared Python preparation and activate it in the current Host process |
| `/pbot agent {"action":"list"}` | Manage specialists; all actions are listed below |
| `/pbot chat {"agentId":"AGENT_ID","text":"Additional instructions"}` | Human chat with optional files; first pauses the specialist's team automatically |
| `/pbot records {"agentId":"AGENT_ID"}` | Read a specialist's complete native event records |
| `/pbot team {"action":"list"}` | Manage teams and read public messages |
| `/pbot post {"teamId":"TEAM_ID","text":"Public information"}` | Post as the human user without waking a model |
| `/pbot history {"action":"search"}` | Search history archives; also supports read |

`chat`, `post`, and `records` do not take `action`. There is no `/pbot help`, `/pbot agents`, or `/pbot teams` subcommand in dsh; the two plural forms belong to Pi.

## Specialist commands

`/pbot agent` and the model tool `pbot_agent` share an input contract and reject unknown fields or fields belonging to another action:

| Action | Required fields besides action | Optional fields | Purpose |
| --- | --- | --- | --- |
| `start` | None | `name`, `message`, `prompts`, `files`, `provider`, `model`, `thinking`, `cwd`, `tools`, `noSkills` | Create a specialist and return after acceptance, without waiting for completion |
| `list` | None | None | List specialists for the current parent session |
| `status` | `agentId` | None | Inspect execution and the latest cycle without reading report text |
| `send` | `agentId`, `message` | `delivery` | Add a delegated task to a live specialist |
| `rename` | `agentId`, `name` | None | Rename a specialist |
| `read` | `agentId` | `cycleId`, `offset`, `limit` | Read one work cycle's final report without blocking |
| `stop` | `agentId` | None | Request stopping and preserve history; the result may still be stopping |
| `resume` | `agentId`, `message` | None | Resume a stopped specialist with a new request, without replaying previous work |

A start without initial text or files creates an idle specialist and makes no model call. It still needs a valid provider/model selection, inherited or explicit; select a model in dsh first. Each parent session allows at most 50 live, starting, or disposing specialists. They use independent native Agent/Session instances in the same process, require no tmux, and do not inherit the parent chat history.

| Start option | Meaning |
| --- | --- |
| `name` | A single-line name of 1–64 characters; defaults to the first eight characters of the ID |
| `message`, `prompts` | The message and each prompt contain 1–24000 characters; up to 32 prompts, combined with the message in order into one input |
| `files` | Up to 32 server file paths, relative to the original workspace root; files alone can start a task |
| `cwd` | Defaults to the original workspace root; relative paths are resolved against that root |
| `provider`, `model` | Native dsh provider route and model ID, each 1–128 characters; inherit the parent's selection by default |
| `thinking` | A native dsh reasoning effort ID; changing provider/model does not inherit another model's effort |
| `tools` | A nonempty array of native capability tool names, not the `run_code` transport name; team members must retain `pbot_team_message` |
| `noSkills` | Defaults to false; true disables model skill discovery and the skill tool; explicit user skill commands retain native behavior |

Specialist creation and resume apply the parent's native preset, including its file tools, AGENTS files, and skill discovery, before applying specialist tool restrictions. An explicit complete persona supplies its full behavior requirements through the host.

Pi-only `noExtensions`, `noPromptTemplates`, and `noContextFiles` are rejected. `send.delivery` is `steer` by default, to supplement current work, or `followUp`, for after current work. `send/resume` do not accept files, prompts, or model-change options. A team reservation blocks private send; pause the team and let in-flight work finish first.

```text
/pbot agent {"action":"start","name":"Evidence reviewer"}
/pbot agent {"action":"send","agentId":"AGENT_ID","message":"Check the sources and list missing evidence.","delivery":"followUp"}
/pbot agent {"action":"rename","agentId":"AGENT_ID","name":"Source reviewer"}
/pbot agent {"action":"status","agentId":"AGENT_ID"}
/pbot agent {"action":"read","agentId":"AGENT_ID","offset":0,"limit":4000}
/pbot agent {"action":"stop","agentId":"AGENT_ID"}
```

After confirming that the specialist has stopped, resume with a new request:

```text
/pbot agent {"action":"resume","agentId":"AGENT_ID","message":"Check the new material and report only what changed."}
```

Report read selects the latest cycle by default. Offset defaults to 0; limit defaults to 16000, with a range of 1–16000 UTF-16 code units. For subsequent pages, keep the returned `cycle.cycleId` and pass `nextOffset` as offset; null means the current report is fully read. Inspect `cycle.state` and the report for work results. Human reads preserve the model's completion notification.

## Human chat and full records

`/pbot chat` requires `agentId` and accepts `text`, `delivery`, and `files`. Supply at least one of nonblank text, server files, or native input attachments. Text is limited to 24000 characters; delivery is `steer` by default or `followUp`. This command uses `text`, while agent commands use `message`.

```text
/pbot chat {"agentId":"AGENT_ID","text":"Check the definitions in the attachment.","delivery":"steer","files":["projects/review/notes.txt"]}
/pbot records {"agentId":"AGENT_ID","offset":0,"limit":30}
```

Relative chat file paths use the specialist's cwd fixed at creation. Choose either server files or local input attachments, up to 32 per request. Image formats and byte limits follow native admission rules. Use native input controls for uploads; do not send a JSON `attachments` field. Chat automatically pauses the specialist's team first and rejects input if pausing fails. After a successful pause, it can steer in-flight work. A queued result means only that the input was queued. Human intervention creates interactive/mixed cycles that are not automatically published. Create a new specialist when you need a separate confidential context. The specialist must be live; resume it first if stopped.

`records` reads complete events, distinct from the final report returned by agent read. It can read stopped specialists without resuming them or acknowledging notifications.

| Read mode | Request fields and defaults | Continue reading |
| --- | --- | --- |
| Event list, without seq | `agentId`; `limit=30`, range 1–100 events; offset defaults to the most recent page, while explicit `offset=0` starts at the beginning | Returns events, total, nextOffset; pass nextOffset as offset |
| One event, with seq | `agentId`, `seq` from the list, ≥0; `format="json"` or `"text"`; `textOffset=0`; `textLimit=12000`, range 2–24000 | Keep seq/format and pass the returned nextOffset as **textOffset** |

Event text uses UTF-16 code units. Text format falls back to JSON when no text can be extracted. With seq, use textOffset/textLimit instead of the list's offset/limit. Replace the example seq with one returned by the list:

```text
/pbot records {"agentId":"AGENT_ID","seq":0,"format":"json","textOffset":0,"textLimit":12000}
```

## Teams and public messages

`/pbot team` and the model tool `pbot_team` share these actions:

| Action | Required fields besides action | Optional fields | Purpose |
| --- | --- | --- | --- |
| `create` | `name`, `brief`, `members` | None | Create a fixed-membership team without calling a model |
| `list` | None | None | List teams |
| `status` | `teamId` | None | Inspect batches, reservations, and unconfirmed outcomes |
| `read` | `teamId` | `afterSeq`, `seq`, `offset`, `limit` | Read original public messages |
| `run` | `teamId`, `instruction`, `mode` | `rounds`, `maxConcurrent`, `timeoutSeconds` | Start a new batch |
| `pause` | `teamId` | None | Stop new scheduling while allowing in-flight work to finish |
| `close` | `teamId` | None | Close when no batch is running and no request remains in flight; preserve members and history |

Create requires a single-line name of 1–64 characters and a brief of 1–24000 characters. Members is an array of 1–50 `{agentId,role}` entries, with roles of 1–4000 characters. Members must be distinct, belong to this parent session, and not belong to another unclosed team. To change membership, close the old team and create another.

Run's instruction must be nonblank and at most 24000 characters. Mode is required: `roundRobin` runs members in order with concurrency 1; `parallel` runs them concurrently, completing every member in a round before the next round. `rounds` defaults to 2, range 1–10. For parallel mode, `maxConcurrent` defaults to min(2,member count), range 1–50 and no greater than the member count. `timeoutSeconds` defaults to 900, range 1–86400, for the whole batch. Run requires live, idle members with ready team integration and no pending private input.

First create two specialists, then use their actual IDs to create a team:

```text
/pbot team {"action":"create","name":"Evidence review","brief":"Check evidence quality and the limits of the conclusions.","members":[{"agentId":"AGENT_A","role":"Check primary sources"},{"agentId":"AGENT_B","role":"Review assumptions and counterarguments"}]}
/pbot post {"teamId":"TEAM_ID","text":"Use only the supplied material and list evidence gaps explicitly."}
/pbot team {"action":"run","teamId":"TEAM_ID","instruction":"Each member should report findings and unresolved questions.","mode":"parallel","rounds":1,"maxConcurrent":2,"timeoutSeconds":900}
/pbot team {"action":"status","teamId":"TEAM_ID"}
/pbot team {"action":"read","teamId":"TEAM_ID","afterSeq":0,"limit":4000}
/pbot team {"action":"pause","teamId":"TEAM_ID"}
```

Pause does not stop specialists. Wait until status reports `activeCount=0` before closing:

```text
/pbot team {"action":"close","teamId":"TEAM_ID"}
```

There is no team resume action; continue by starting a new run with a new instruction. A paused team may still have in-flight requests. Unresolved results can include failures, unknown outcomes, or mixed input; query reports and actual status before continuing. Only normally completed, pure team responses are automatically published. See [specialist collaboration](agent-collaboration.md) for the full rules.

`/pbot post` requires teamId and nonblank text of at most 24000 characters. Optional `replyTo` references an existing message seq, ≥1. A stored result means only that the message was saved; it does not wake a model or add a round. Closed teams reject new posts. Human authors are user; the model tool `pbot_team_message` requires `action:"post"` or `action:"read"`, and the service determines coordinator/member authorship.

Public-message read defaults afterSeq to 0 and returns later messages. Seq starts at 1 and can select one message. Offset defaults to 0; a nonzero offset requires seq. Limit defaults to 16000, range 1–16000 UTF-16 code units across message bodies, not a message count. Finish a truncated body using its seq and `nextOffset`, then continue the list with the list's `nextAfterSeq` as afterSeq.

## History queries

`/pbot history` and the model tool `pbot_history` support these effective parameters:

| Action | Required fields | Optional fields and defaults |
| --- | --- | --- |
| `search` | action | `host` is pi/dsh, omitted for both; `query`, `sessionId`, `from`, `to`; `offset=0`; `limit=20`, range 1–50 matches |
| `read` | action, `id` | `host`; `offset=0`; `limit=12000`, range 1–24000 UTF-16 code units; `childrenOffset=0`, with a fixed page size of 20 children |

`query` performs case-insensitive substring search over ready exchanges and summaries. Omit it or use blank text to list sessions. `sessionId` filters native sessions; read's `id` is an archive node ID returned by a query, not a specialist ID. Date fields are **from/to**, not start/end. Use ISO timestamps with explicit time zones. A date-only to value such as `2026-11-07` means midnight UTC, not the end of that day.

```text
/pbot history {"action":"search","host":"dsh","query":"evidence","from":"2026-11-01T00:00:00+08:00","to":"2026-11-07T23:59:59.999+08:00","offset":0,"limit":20}
/pbot history {"action":"read","host":"dsh","id":"NODE_ID","offset":0,"limit":12000,"childrenOffset":0}
```

Search returns matches, total, nextOffset, and warnings. Retain the filters and use nextOffset for the next page. Read returns node: pass `node.nextOffset` as offset for text and `node.nextChildrenOffset` as childrenOffset for children. Follow IDs in parents/children to navigate. There is no childrenLimit parameter. Summaries provide leads; check important facts against original exchanges. History archives do not replace full specialist tool records.

Pi maintains `.pi/pbot/history/`, and dsh maintains `.dsh/pbot/history/`. Both query existing archives while updating and summarizing only their own source. Queries do not call a model. After a normal main interaction ends, idle preparation uses that host's current model to fill pending summaries; new human input cancels preparation first. See [history](history.md).

## Model tools

| Tool | Operations |
| --- | --- |
| `pbot_agent` | start, send, rename, status, list, read, stop, resume |
| `pbot_team` | create, list, status, read, run, pause, close |
| `pbot_team_message` | read, post; read uses team-read paging, and post takes teamId/text/optional replyTo |
| `pbot_history` | search, read |

Models use the actual tool schemas; people use the commands or management pages above. Chat and records are human management entries without model tools of the same names.
