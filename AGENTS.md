# Repository Guidelines

## Structure

Personal Bot is a harness-agnostic workspace and cross-harness specialist layer. It provides a Pi extension, a native dsh Host/Web integration, standard Claude Code and Antigravity plugins, a shared stdio MCP server for cross-harness ACP delegation, and a standalone CLI (`bin/pbot.mjs`).

- `src/pbot.ts`: Pi dependency assembly and registration.
- `src/dsh.ts`: dsh Host assembly; `src/ui/dsh/index.ts` is the native Web entry.
- `src/plugin.ts` / `src/claude.ts`: unified plugin-host CLI/hook entry (`claude`, `antigravity`) and backward-compatible Claude entry.
- `src/mcp.ts`: standalone stdio MCP server entry exposing `pbot_agent` for cross-harness ACP delegation.
- `src/extension/`: host lifecycles, commands, `plugin-runtime.ts`, `mcp-agents.ts`, `acp-worker.ts`, and `setup-cli.ts`.
- `src/integrations/`: host protocol adapters (`hosts/claude.ts`, `hosts/antigravity.ts`, `pi/`, `dsh/`, `acp/`), unified context assembly (`agent-resources.ts`), and installation adapters.
- `src/services/`: host-neutral business rules (`agents/`, `workspace/`, `history/`, `installation/`).
- `src/model/`: plain data types and narrow capability contracts (`plugin-host.ts`, `acp.ts`, `agent.ts`, `team.ts`, `history.ts`, `workspace-config.ts`); no business logic or host SDK types.
- `src/storage/`: atomic JSON, agent/ACP control files, and history storage.
- `src/tools/`: Pi/dsh tool contracts, execution adapters, and tool registration.
- `src/ui/`: Pi confirmation queue and dsh Web UI.
- `src/common/`: shared JSON, validation, file, path, and version helpers.
- `.claude-plugin/`, `hooks/hooks.json`, `.mcp.json`: Claude plugin discovery, command hooks, and MCP server declaration.
- `resources/`: model-facing prompts, roles, skills, references, and templates (strictly separate from developer docs).
- `tests/`: real-process Node tests under domain subdirectories; real-model acceptance runs separately.
- `docs/`: current developer architecture and user guides.
- `scripts/`: build helpers (`build-cli.mjs`, `build-dsh.mjs`, `build-plugins.mjs`) and consumer checks.
- `bin/pbot.mjs`: standalone CLI (`setup`, `install-antigravity`, `mcp`).
- `lib/`: generated CLI, dsh, plugin runtime, standalone `lib/extension/{mcp,acp-worker}.js`, and self-contained `lib/antigravity-plugin/`. Do not edit generated files.
- `dist/`: generated test imports. Do not edit generated files.

Keep the top-level layers and enforce boundaries with `dependency-cruiser`. Read [docs/architecture-guidelines.md](docs/architecture-guidelines.md) and [docs/technical-design.md](docs/technical-design.md) before changing module boundaries, and [docs/plugin-hosts-design.md](docs/plugin-hosts-design.md) before changing plugin-host adapters, hooks, or the cross-harness MCP/ACP bridge.

All hosts share `<workspace>/.pbot/config.json` for explicit workspace opt-in (checking only the bound workspace root) and optional `acp` backend configuration. Missing, disabled, or invalid configuration keeps business behavior inactive. Preserve existing user materials, historical archives, and backups; never migrate configuration automatically or delete user data.

Release versions use `MAJOR.MINOR.PATCH` from `package.json`. Subagent compatibility follows the minor line before 1.0, then the major line. Keep persisted contracts stable within a line; do not add storage or workspace upgrade version counters.

## Commands

Full development and acceptance use Linux/macOS with Node.js 24.9+. Pi consumers, standalone CLI, plugin hooks, and the bundled MCP/ACP runtime target Node.js 22.19+. Claude Code baseline is 2.1.325+; Antigravity CLI baseline is `agy` 1.5+. dsh requires Node.js 24.9+ (current dev baseline `0.2.2-rc.1`).

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: run TypeScript typecheck and `dependency-cruiser` boundary checks.
- `npm run build`: clean `dist`, compile tests, then build `cli` → `dsh` → `plugins` into `lib`.
- `npm run build:cli`: clean `lib` and compile the standalone CLI.
- `npm run build:dsh`: compile dsh Host and Web client into `lib` (run after `build:cli`).
- `npm run build:plugins` (`build:claude` alias): compile shared plugin runtime, bundle standalone `lib/extension/mcp.js` and `lib/extension/acp-worker.js`, generate native experts, sync Claude manifests, and assemble `lib/antigravity-plugin/`.
- `npm test`: build and run all Node tests serially (`--test-concurrency=1`).
- `agy plugin validate --strict ./lib/antigravity-plugin --json`: validate the built Antigravity plugin.
- `claude plugin validate --json ./.claude-plugin/plugin.json`: validate the Claude plugin.

Host SDKs remain optional peer dependencies, never runtime dependencies. Do not add `@modelcontextprotocol/sdk` as a runtime dependency; the stdio MCP server uses Node built-ins and bundles `@agentclientprotocol/sdk` into `lib/extension/acp-worker.js` so plugin caches run without `node_modules`.

## Development Principles

- **Two-pillar architecture**: separate (1) workspace/context integration via narrow host adapters (`PluginHostAdapter` for hook-based hosts) from (2) cross-harness specialist delegation via shared `AgentService` + open ACP backends (`pi`, `dsh`, `claude`, `antigravity`, `codex`, and arbitrary custom targets in `.pbot/config.json`).
- **Isolate host differences**: keep protocol parsing/formatting in `src/integrations/hosts/*` and `src/integrations/{pi,dsh,acp}/*`; keep business rules in `src/services/`.
- **Avoid custom TUI bloat**: rely on host-native UI, sessions, permissions, and skills. Keep Pi `/pbot` minimal (`init`, `status`, `enter` for tmux attach) and avoid custom TUI menus, readers, or search screens. dsh retains its dedicated Web management UI.
- **No host lock-in**: cross-harness delegation is exposed uniformly via Pi/dsh native `pbot_agent` and via the zero-external-dep stdio MCP server (`lib/extension/mcp.js` / `pbot mcp`) for Claude, Antigravity, Codex, and any other MCP-capable host. Routing preferences ("which harness for coding/analysis/exploration") live in workspace materials, not hardcoded logic.
- **Trusted-model assistant**: use native CLI/MCP and project-declared Python/tool environments without wrapper tools or bypassable software permission gates. Hard limits belong to credentials, external services, or execution sandboxes.
- **Keep it simple**: delete dead code; do not add unused abstractions, upgrade frameworks, or file-hash checks.

## Two Documentation Methodologies (Keep Strictly Separate)

1. **Developer & User Documentation (`AGENTS.md`, `README*.md`, `docs/`, `scripts/README.md`)**:
   - Maintain current design goals, design methods, module boundaries, and operational instructions only.
   - Consolidate and rewrite sections directly; delete obsolete constraints, historical patches, ADRs of superseded choices, and test diaries (Git preserves history).
2. **Model-Facing Runtime Materials (`resources/`)**:
   - Read and follow [docs/model-instruction-guidelines.md](docs/model-instruction-guidelines.md) before changing anything in `resources/` or tool descriptions.
   - State concrete actions, paths, and tool usage directly; load specialized methods on demand; never leak repository architecture, build details, or developer guidelines into model context.

## Style & Tests

- TypeScript ESM, 2-space indentation, double quotes, semicolons, `.js` suffixes in relative imports, `import type` for type-only imports, strict compiler checks.
- Tests use `node:test` and `node:assert/strict` with real local files, processes, and host SDKs—no mocks, stubs, fake models, or personal credentials. Never assert prose wording in prompts or docs.
- Use concise `feat:` / `fix:` / `docs:` commit prefixes. Run `npm run check`, `npm test`, native plugin validations, and `git diff --check` before submission.
