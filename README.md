# Personal Bot

English | [简体中文](README.zh-CN.md)

**A harness-agnostic personal assistant workspace and unified MCP cross-harness delegation layer.**

Personal Bot brings shared workspace materials and skills to [Pi](https://pi.dev), dsh, Claude Code, Antigravity, Codex, Qoder CLI, and extensible plugin hosts, while unifying cross-harness ACP v1 delegation onto a clean 6-tool stdio MCP server (`worker_create`, `worker_close`, `worker_request`, `worker_response`, `worker_output`, `worker_discover`). Host-native subagent and team tools remain untouched and complementary; Pi and dsh also provide `pbot_history`.

Quick links (Chinese): [Documentation Index](docs/README.md) · [Pi](docs/hosts/pi.md) · [dsh](docs/hosts/dsh.md) · [Claude Code](docs/hosts/claude-code.md) · [Antigravity](docs/hosts/antigravity.md) · [Cross-Harness Workers](docs/guides/cross-harness-workers.md).

## Enable a workspace

After installation, run init in the target workspace (Pi / dsh / Antigravity: `/pbot init`; Claude Code: `/personal-bot:pbot init`). This creates missing material directories and root `AGENTS.md`, and enables the shared `.pbot/config.json`:

```json
{ "enabled": true }
```

Missing, disabled, or invalid configuration keeps Personal Bot inactive without affecting host-native capabilities. Only the bound workspace root is checked. See [workspace configuration](docs/guides/workspace-configuration.md).

## Install

The workspace CLI runs from the workspace root or accepts `--workspace <dir>`. Install it with `npm install -g personal-bot`, or use `npx personal-bot@<installed-plugin-version>`. Use `pbot init`, `pbot status`, `pbot upgrade|update`, and `pbot history status|list|summary|migrate|search|read`. Run `pbot upgrade` to update the global CLI and all host plugins bound to the current workspace to the latest stable npm release. During initialization and in enabled workspaces, the CLI also selects a version that meets the registered plugins’ requirements. [Workspace configuration](docs/guides/workspace-configuration.md) · [CLI and history guide](docs/guides/history.md)

### Pi

Requires Linux/macOS, Node.js 22.19+, and npm:

```bash
# Interactive setup wizard
npx personal-bot@latest setup

# Or install into an existing Pi workspace
pi install --local npm:personal-bot
pi
```

Run `/pbot init`. Once enabled, Pi automatically registers the `pbot` stdio MCP server (`worker_*`), exposes `pbot_history`, and provides `/pbot init | status | history | worker`. See the [Pi guide](docs/hosts/pi.md).

### dsh

Requires Node.js 24.9+, npm, pnpm, and dsh `0.2.2-rc.1+`:

```bash
npm install -g @deepseek-ai/dsh@latest pnpm@latest
dsh --profile pbot --from-default-profile web --dump-config
dsh plugin --profile pbot add personal-bot@latest
dsh --profile pbot
```

Select a workspace and run `/pbot init`. Once enabled, dsh mounts `mcp__pbot__worker_*` via `@deepseek-ai/dsh-mcp-client`, exposes `pbot_history`, a streamlined Workspace/History Web view, and `/pbot status | init | worker | history`. See the [dsh guide](docs/hosts/dsh.md).

### Claude Code

Requires Linux/macOS, Node.js 22.19+, and Claude Code `2.1.325+`:

```text
/plugin install personal-bot --marketplace realqiyan/personal-bot
```

Run `/personal-bot:pbot init` in the workspace. Command hooks inject main-session context and gate bundled skills when disabled without intercepting native `Agent` subagents; `.mcp.json` mounts `worker_*`. See the [Claude Code guide](docs/hosts/claude-code.md).

### Codex / Qoder CLI

Install the Codex or Qoder CLI plugin and initialize the workspace with `pbot plugin codex init` or `pbot plugin qoder init`. See the [installation and workspace guide](docs/hosts/codex-qoder.md).

### Antigravity

Requires Linux/macOS, Node.js 22.19+, and Antigravity CLI (`agy` `1.5+`):

```bash
npx personal-bot@latest install-antigravity
```

Run `/pbot init` in the workspace. Hooks inject `SessionStart` context and gate bundled skills when disabled without intercepting native `invoke_subagent` or `/swarm`; `mcp_config.json` mounts `worker_*`. See the [Antigravity guide](docs/hosts/antigravity.md).

### Other MCP hosts & custom ACP harnesses

Point any MCP client (Codex, Cursor, etc.) at:

```bash
npx personal-bot@latest mcp
# Or after global install
pbot mcp
```

Supports built-in presets (`pi`, `dsh`, `claude`, `antigravity`, `codex`, `qoder`) and arbitrary custom ACP v1 binaries declared in `.pbot/config.json` under `acp` (`{ "command", "args", "env?" }`). See [cross-harness workers](docs/guides/cross-harness-workers.md).

## Workspace materials

| Location | Purpose |
| --- | --- |
| `.pbot/config.json` | Shared workspace opt-in and extensible ACP harness configuration |
| `AGENTS.md` | Project index, working agreements, and optional harness routing preferences |
| `areas/`, `projects/`, `knowledge/` | Long-term areas, project deliverables, and reusable methods |
| `providers/` | External CLI/MCP guides and data definitions |
| `scratch/` | Temporary scripts, data, and working environments |
| `agents/` | Role additions (`coordinator.md`, `general-purpose.md`) |
| `.pbot/history/` | Raw exchanges from connected hosts in `raw/` and derived summaries in `summaries/` |

## Development

The package version is **0.3.4**. Full development uses Linux/macOS and Node.js 24.9+:

```bash
npm ci --ignore-scripts
npm run check
npm test
agy plugin validate --strict ./lib/antigravity-plugin --json
claude plugin validate --json ./.claude-plugin/plugin.json
git diff --check
```

- [Documentation index](docs/README.md)
- [Architecture principles](docs/architecture/principles.md) · [Technical design](docs/architecture/design.md) · [Extensibility design](docs/architecture/extensibility.md)
- [Release guide](docs/maintainers/release.md) · [Maintenance scripts](scripts/README.md) · [Domain terms](CONTEXT.md)

## License and disclaimer

Personal Bot is licensed under MIT. [License](LICENSE) · [Disclaimer](DISCLAIMER.md#english)
