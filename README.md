# Personal Bot

English | [简体中文](README.zh-CN.md)

**A harness-agnostic personal assistant workspace and unified MCP cross-harness delegation layer.**

Personal Bot connects [Pi](https://pi.dev), DeepSeek Harness (`dsh`), Claude Code, Antigravity, Codex, Qoder CLI, and any MCP-compatible host to one shared workspace—providing shared materials and skills, workspace-scoped MCP servers, cross-host conversation history, and cross-harness ACP v1 worker delegation. Host-native subagent and team tools remain untouched.

> Most detailed guides in `docs/` are currently in Chinese: [Documentation Index](docs/README.md) · [Pi](docs/hosts/pi.md) · [dsh](docs/hosts/dsh.md) · [Claude Code](docs/hosts/claude-code.md) · [Antigravity](docs/hosts/antigravity.md) · [Codex & Qoder CLI](docs/hosts/codex-qoder.md).

## Features

1. **Shared Workspace & Skills**
   - Organizes long-term areas, project deliverables, reusable knowledge, provider guides, scratchpads, and role guidance under one workspace layout (`AGENTS.md`, `areas/`, `projects/`, `knowledge/`, `providers/`, `scratch/`, `agents/`, `.agents/skills/`).
   - Opt-in per workspace via `.pbot/config.json` (checks only the bound workspace root). Missing, disabled, or invalid config keeps Personal Bot inactive.
   - Granular feature switches under `features` (`prompts`, `skills`, `mcp`, `history`, all `true` by default) let you enable only the capabilities you want.

2. **Cross-Harness Delegation (`worker_*`)**
   - Exposes 6 read/write-separated tools (`worker_discover`, `worker_create`, `worker_request`, `worker_response`, `worker_output`, `worker_close`) through a single stdio MCP server (`pbot mcp`).
   - Built-in ACP v1 presets for `pi`, `dsh`, `claude`, `antigravity`, `codex`, and `qoder`, plus arbitrary custom ACP v1 binaries declared in `.pbot/config.json`.
   - Complements host-native subagents (Claude `Agent`/teams, Antigravity `invoke_subagent`/`/swarm`, dsh `subagent`) without intercepting or replacing them.

3. **Workspace-Shared MCP (`.pbot/mcp.json`)**
   - Manage stdio and Streamable HTTP MCP servers once per workspace via `pbot mcp add|list|remove` with `${ENV_VAR}` expansion.
   - Pi and dsh mount them natively; plugin hosts access them on demand via `workspace_mcp_discover` / `workspace_mcp_call`; ACP workers inherit them automatically.

4. **Cross-Host Conversation History (`.pbot/history/`)**
   - Archives main-session exchanges from connected hosts into `.pbot/history/raw/` (monthly layout by default).
   - Generates incremental session and monthly summaries via `pbot history summary`.
   - Provides read-only search and drill-down via `pbot_history` (Pi/dsh), MCP `history_search` / `history_read` (plugin & MCP hosts), and `pbot history` CLI.

### Supported Hosts

| Host | Integration | Workspace Init | Cross-Harness MCP | History |
| --- | --- | --- | --- | --- |
| **Pi** | Native extension | `/pbot init` | Auto-mounted + `/pbot worker` | `pbot_history` + `/pbot history` |
| **dsh** | Native plugin + Web view | `/pbot init` | Auto-mounted + `/pbot worker` | `pbot_history` + Web view + `/pbot history` |
| **Claude Code** | Native plugin (hooks + MCP) | `/personal-bot:pbot init` | Auto-mounted | Hooks + MCP `history_*` |
| **Antigravity** | Native plugin (hooks + MCP) | `/pbot init` | Auto-mounted | Hooks + MCP `history_*` |
| **Codex** | Native plugin (hooks + MCP) | `pbot plugin codex init` | Auto-mounted | Hooks + MCP `history_*` |
| **Qoder CLI** | Native plugin (hooks + MCP) | `pbot plugin qoder init` | Auto-mounted | Hooks + MCP `history_*` |
| **Other MCP hosts** (Cursor, etc.) | Stdio MCP (`pbot mcp`) | `pbot init` | Manual MCP config | MCP `history_*` + CLI |

## Installation

**Prerequisites**: Linux or macOS, Node.js `22.19+` and npm (`dsh` requires Node.js `24.9+` and `pnpm`).

### 1. Install the shared CLI (recommended)

```bash
npm install -g personal-bot
```

The `pbot` CLI works across all hosts (`pbot install`, `pbot init`, `pbot status`, `pbot upgrade`, `pbot mcp`, `pbot history`). If you prefer not to install globally, replace `pbot` with `npx personal-bot@latest`.

### 2. Install host plugin(s)

**Option A: Via `pbot install` (recommended)**

```bash
# Install for all detected hosts on this machine (skips hosts not installed)
pbot install all

# Or install for a single host: pi | dsh | claude | antigravity | codex | qoder
pbot install pi --workspace /path/to/workspace
pbot install claude
```

Pass `--dsh-profile <name>` to customize the `dsh` profile (defaults to `pbot`). For Codex, review and trust the Personal Bot hooks in `/hooks` before starting a session.

**Option B: Native install per host**

- **Pi** (in the target workspace): `pi install --local npm:personal-bot` · [Pi Guide](docs/hosts/pi.md)
- **dsh** (`0.2.2-rc.1+`, Node.js `24.9+`, `pnpm`): `dsh plugin --profile pbot add personal-bot@latest` (first time: `dsh --profile pbot --from-default-profile web --dump-config`) · [dsh Guide](docs/hosts/dsh.md)
- **Claude Code** (`2.1.325+`): `/plugin install personal-bot --marketplace realqiyan/personal-bot` · [Claude Code Guide](docs/hosts/claude-code.md)
- **Antigravity** (`agy` `1.5+`): `agy plugin install "$(npm root -g)/personal-bot/lib/antigravity-plugin"` · [Antigravity Guide](docs/hosts/antigravity.md)
- **Codex**: `codex plugin marketplace add "$(npm root -g)/personal-bot/lib/codex-marketplace" && codex plugin add personal-bot@pbot-local` (then trust hooks in `/hooks`) · [Codex & Qoder CLI Guide](docs/hosts/codex-qoder.md)
- **Qoder CLI**: `qodercli plugin install "$(npm root -g)/personal-bot/lib/qoder-plugin"` · [Codex & Qoder CLI Guide](docs/hosts/codex-qoder.md)
- **Other MCP Hosts (Cursor, etc.)**: Configure a stdio MCP server pointing to `pbot mcp` (or `npx personal-bot@latest mcp`).

## Usage

### Enable a workspace

Run initialization once in the target workspace root (all hosts share the same `.pbot/config.json`):

```bash
# From terminal (works for all hosts)
pbot init --workspace /path/to/workspace
```

Or run the host command inside a session:
- Pi / dsh / Antigravity: `/pbot init`
- Claude Code: `/personal-bot:pbot init`
- Codex / Qoder CLI: `pbot plugin codex init` or `pbot plugin qoder init`

`init` creates missing material directories and root `AGENTS.md` without overwriting existing files, and enables `.pbot/config.json`:

```json
{
  "enabled": true,
  "features": {
    "prompts": true,
    "skills": true,
    "mcp": true,
    "history": true
  }
}
```

Check workspace status and plugin version sync at any time with `pbot status` (or `/pbot status`). See [Workspace Configuration](docs/guides/workspace-configuration.md).

### Workspace layout

| Path | Purpose |
| --- | --- |
| `.pbot/config.json` | Workspace opt-in, `features` toggles, `acp` harnesses, `history` / `summary` settings |
| `.pbot/mcp.json` | Workspace-shared stdio / HTTP MCP servers |
| `.pbot/history/` | Cross-host raw exchanges (`raw/`) and derived summaries (`summaries/`) |
| `AGENTS.md` | Project index, working agreements, and optional harness routing preferences |
| `areas/`, `projects/`, `knowledge/` | Long-term areas, project deliverables, and reusable methods |
| `providers/` | External CLI/MCP usage guides and data definitions |
| `scratch/` | Temporary scripts, data, and experiments |
| `agents/` | Role additions (`coordinator.md`, `general-purpose.md`) |
| `.agents/skills/` | Workspace-local skills (`<name>/SKILL.md`) shared across hosts |

### Common workflows

**1. Cross-harness delegation (`worker_*`)**

Ask the assistant to delegate to another harness (for example, "use Codex to implement and test module A" or "ask Claude to review this diff"), or invoke `/pbot worker` directly in Pi/dsh:

```text
/pbot worker overview
/pbot worker backends
/pbot worker models claude
/pbot worker create {"backend":"codex"}
```

To use built-in ACP targets, install and authenticate the corresponding target CLI (`pi-acp`, `dsh`, `@agentclientprotocol/claude-agent-acp`, `agy`, `@agentclientprotocol/codex-acp`, or `qodercli`). To add any custom ACP v1 binary, declare it in `.pbot/config.json`:

```json
{
  "enabled": true,
  "acp": {
    "my-harness": {
      "command": "/absolute/path/to/my-acp",
      "args": ["--stdio"],
      "env": { "MY_HARNESS_MODE": "headless" },
      "permission": "ask"
    }
  }
}
```

See [Cross-Harness Workers](docs/guides/cross-harness-workers.md).

**2. Workspace-shared MCP servers**

```bash
# Add a stdio MCP server
pbot mcp add sqlite --description "Local SQLite" -- npx -y @modelcontextprotocol/server-sqlite ./data.db

# Add a Streamable HTTP MCP server (references env vars instead of plaintext secrets)
pbot mcp add internal-api --url https://mcp.example.com/mcp --header Authorization='Bearer ${INTERNAL_MCP_TOKEN}'

# List or remove
pbot mcp list
pbot mcp remove sqlite
```

**3. Cross-host history & summaries**

```bash
pbot history status
pbot history summary
pbot history search "architecture decision" --limit 10
pbot history read <node-id>
```

See [History Guide](docs/guides/history.md).

## Upgrade

### Unified upgrade (recommended)

In a workspace root (or with `--workspace <dir>`), run:

```bash
pbot upgrade
# Alias: pbot update
```

`pbot upgrade` updates the global `pbot` CLI and all host plugins bound to the current workspace to the latest stable npm release while preserving each host's install scope. Useful options:

- `--version <x.y.z>`: pin a specific target version
- `--hosts <h1,h2>`: upgrade only specific hosts (e.g. `claude,codex`)
- `--dsh-profile <name>`: specify the dsh profile when it cannot be inferred automatically

When multiple hosts in the same workspace are on different versions, `pbot status` reports `outOfSync: true`.

### Per-host manual upgrade

- **Global CLI**: `npm install -g personal-bot@latest`
- **Pi**: `pi install --local npm:personal-bot@latest` (then run `/reload` in Pi)
- **dsh**: Stop the running dsh service, then run `dsh plugin --profile pbot update personal-bot --latest`
- **Claude Code**: `claude plugin update personal-bot` (restart Claude Code session)
- **Antigravity**: Run `npm install -g personal-bot@latest`, then `agy plugin install "$(npm root -g)/personal-bot/lib/antigravity-plugin"` or `pbot install antigravity` (restart Antigravity session)
- **Codex**: Run `npm install -g personal-bot@latest`, then `codex plugin add personal-bot@pbot-local` (re-check `/hooks` if hook definitions changed)
- **Qoder CLI**: Run `npm install -g personal-bot@latest`, then `qodercli plugin install "$(npm root -g)/personal-bot/lib/qoder-plugin"`

## Uninstall

### Disable in a workspace only

To turn off Personal Bot in a single workspace without removing plugins or data, set `"enabled": false` in `.pbot/config.json` (or delete `.pbot/config.json`).

### Uninstall plugins and CLI

Remove only the components you installed:

- **Global CLI**: `npm uninstall -g personal-bot`
- **Pi** (in the workspace): `pi remove --local npm:personal-bot`
- **dsh** (stop service first): `dsh plugin --profile pbot remove personal-bot`
- **Claude Code**: `claude plugin uninstall personal-bot`
- **Antigravity**: `agy plugin uninstall personal-bot`
- **Codex**: `codex plugin remove personal-bot@pbot-local` (optional: `codex plugin marketplace remove pbot-local`)
- **Qoder CLI**: `qodercli plugin uninstall personal-bot`
- **Other MCP hosts**: Remove the `pbot` entry from your host's MCP configuration.

### Optional data cleanup

Uninstalling never deletes your workspace materials (`AGENTS.md`, `areas/`, `projects/`, `knowledge/`, `providers/`, `scratch/`, `agents/`, `.agents/skills/`) or local state. If you want to remove Personal Bot state files as well:

- Workspace state: `.pbot/` inside the workspace (contains `config.json`, `mcp.json`, and `history/`)
- User-level cache & bindings: `~/.pbot/`

## Documentation & Development

- [Documentation Index](docs/README.md) · [Workspace Configuration](docs/guides/workspace-configuration.md) · [Cross-Harness Workers](docs/guides/cross-harness-workers.md) · [History](docs/guides/history.md) · [Capabilities](docs/guides/capabilities.md)
- [Architecture Principles](docs/architecture/principles.md) · [Technical Design](docs/architecture/design.md) · [Extensibility](docs/architecture/extensibility.md) · [Release Guide](docs/maintainers/release.md) · [Domain Terms](CONTEXT.md)
- Contributors: see [AGENTS.md](AGENTS.md) for development requirements, build/test commands, and plugin validation.

## License and Disclaimer

Personal Bot is licensed under MIT. [License](LICENSE) · [Disclaimer](DISCLAIMER.md#english)
