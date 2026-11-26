# Repository Guidelines

## Structure

Personal Bot is a harness-agnostic workspace and unified MCP cross-harness delegation layer. It integrates with Pi, dsh Host/Web, Claude Code, Antigravity, and extensible hook-based plugin hosts, while exposing a single stdio MCP server (`worker_create`, `worker_close`, `worker_request`, `worker_response`, `worker_output`, `worker_discover`) for cross-harness ACP v1 delegation without interfering with host-native subagent tools.

- `src/pbot.ts`: Pi assembly (workspace lifecycle, `pbot_history`, native `pi.registerMcpServer("pbot", ...)`).
- `src/dsh.ts`: dsh Host assembly (`pbot_history`, Web workspace/history UI, `@deepseek-ai/dsh-mcp-client` mount for `worker_*`); `src/ui/dsh/index.ts` is the native Web entry.
- `src/plugin.ts` / `src/claude.ts`: runtime-agnostic plugin-host CLI/hook entry (resolves dynamically via `PluginHostRegistry`) and backward-compatible Claude entry.
- `src/mcp.ts`: standalone stdio MCP server entry exposing the 6 `worker_*` tools for cross-harness ACP delegation.
- `src/extension/`: host lifecycles, `/pbot` commands (`init`, `status`, `worker`), `plugin-runtime.ts`, `mcp-workers.ts`, `acp-worker.ts`, `setup-cli.ts`, and ACP member entries (`pi-acp-member.ts`, `dsh/acp-member.ts`).
- `src/integrations/`: extensible plugin-host adapters (`hosts/registry.ts`, `hosts/claude.ts`, `hosts/antigravity.ts`), extensible ACP harness adapters (`acp/registry.ts`, `acp/harnesses/*`), Pi/dsh history & resources, unified context assembly (`agent-resources.ts`), and installation adapters.
- `src/services/`: host-neutral business rules (`agents/`, `workspace/`, `history/`, `installation/`).
- `src/model/`: plain data types and narrow capability contracts (`plugin-host.ts`, `acp.ts`, `agent.ts`, `history.ts`, `workspace-config.ts`); no business logic or host SDK types.
- `src/storage/`: atomic JSON, ACP worker control files, and history storage.
- `src/tools/`: `pbot_history` contracts and Pi/dsh tool registration.
- `src/ui/`: Pi confirmation queue, installer UI, and dsh Web workspace/history UI.
- `src/common/`: shared JSON, validation, schema, file, path, and version helpers.
- `.claude-plugin/`, `hooks/hooks.json`, `.mcp.json`: Claude plugin discovery, command hooks (workspace context & skill gating only — never intercepts native subagents), and MCP server declaration.
- `resources/`: model-facing prompts, roles, skills, references, and templates (strictly separate from developer docs).
- `tests/`: real-process Node tests under domain subdirectories; real-model acceptance runs separately.
- `docs/`: categorized documentation (`docs/README.md` index → `hosts/`, `guides/`, `architecture/`, `maintainers/`).
- `scripts/`: build helpers (`build-cli.mjs`, `build-dsh.mjs`, `build-plugins.mjs`) and consumer checks.
- `bin/pbot.mjs`: standalone CLI (`setup`, `install-antigravity`, `mcp`).
- `lib/`: generated CLI, dsh, plugin runtime, standalone `lib/extension/{mcp,acp-worker}.js`, and self-contained `lib/antigravity-plugin/`. Do not edit generated files.
- `dist/`: generated test imports. Do not edit generated files.

Keep top-level layers unidirectional and enforce boundaries with `dependency-cruiser`. Read [docs/architecture/principles.md](docs/architecture/principles.md), [docs/architecture/design.md](docs/architecture/design.md), and [docs/architecture/extensibility.md](docs/architecture/extensibility.md) before changing module boundaries, host registries, or the MCP/ACP bridge.

All hosts share `<workspace>/.pbot/config.json` for explicit workspace opt-in (checking only the bound workspace root) and optional `acp` harness configuration (`{ command, args, env? }`). Missing, disabled, or invalid configuration keeps business behavior inactive. Preserve existing user materials, historical archives, and backups; never migrate configuration automatically or delete user data.

Release versions use `MAJOR.MINOR.PATCH` from `package.json`. Control record compatibility follows the minor line before 1.0, then the major line. Keep persisted contracts stable within a line; do not add storage or workspace upgrade version counters.

## Commands

Full development and acceptance use Linux/macOS with Node.js 24.9+. Pi consumers, standalone CLI, plugin hooks, and the bundled MCP/ACP runtime target Node.js 22.19+. Claude Code baseline is 2.1.325+; Antigravity CLI baseline is `agy` 1.5+. dsh requires Node.js 24.9+ (current dev baseline `0.2.2-rc.1`).

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: run TypeScript typecheck and `dependency-cruiser` boundary checks.
- `npm run build`: clean `dist`, compile tests, then build `cli` → `dsh` → `plugins` into `lib`.
- `npm run build:cli`: clean `lib` and compile the standalone CLI.
- `npm run build:dsh`: compile dsh Host and Web client into `lib` (run after `build:cli`).
- `npm run build:plugins` (`build:claude` alias): compile shared plugin runtime, bundle standalone `lib/extension/mcp.js` and `lib/extension/acp-worker.js`, and run registered plugin host build targets (Claude manifests + self-contained `lib/antigravity-plugin/`).
- `npm test`: build and run all Node tests serially (`--test-concurrency=1`).
- `agy plugin validate --strict ./lib/antigravity-plugin --json`: validate the built Antigravity plugin.
- `claude plugin validate --json ./.claude-plugin/plugin.json`: validate the Claude plugin.

Host SDKs remain optional peer dependencies, never runtime dependencies. Do not add `@modelcontextprotocol/sdk` as a runtime dependency; the stdio MCP server uses Node built-ins and bundles `@agentclientprotocol/sdk` into `lib/extension/acp-worker.js` so plugin caches run without `node_modules`.

## Development Principles

- **Two-pillar architecture**: separate (1) workspace/context integration via extensible `PluginHostRegistry` / Pi & dsh host adapters from (2) unified cross-harness delegation via the stdio MCP server (`lib/extension/mcp.js` / `pbot mcp`, exposing 6 read/write-separated `worker_*` tools) backed by `AgentService` + extensible `AcpHarnessRegistry`.
- **Complement, never override host-native subagents**: leave Claude `Agent`/teams, Antigravity `invoke_subagent`/`/swarm`, and dsh `subagent` completely untouched; do not ship overriding static `general-purpose` agents or intercept native subagent hooks. Pi/dsh native tools are limited to `pbot_history`, while cross-harness delegation uses unified MCP `worker_*` (plus `/pbot worker` commands).
- **Runtime-agnostic extensibility**: adding a plugin host only requires registering a `PluginHostAdapter` in `PluginHostRegistry` (and a target in `scripts/build-plugins.mjs`); adding an ACP harness only requires `.pbot/config.json` `acp` config (zero code) or registering a specialized `AcpHarnessAdapter` in `AcpHarnessRegistry` without modifying runtime code.
- **Avoid custom UI bloat**: Pi `/pbot` stays minimal (`init`, `status`, `worker`); dsh Web UI keeps only Workspace & History views. Routing preferences live in workspace materials, not hardcoded logic.
- **Keep it simple**: delete dead code; do not add unused abstractions, upgrade frameworks, or file-hash checks.

## Two Documentation Methodologies (Keep Strictly Separate)

1. **Developer & User Documentation (`AGENTS.md`, `README*.md`, `docs/`, `scripts/README.md`)**:
   - Maintain current design goals, design methods, module boundaries, and operational instructions only.
   - Consolidate and rewrite sections directly; delete obsolete constraints, historical patches, and test diaries (Git preserves history).
2. **Model-Facing Runtime Materials (`resources/`)**:
   - Read and follow [docs/architecture/model-instruction-guidelines.md](docs/architecture/model-instruction-guidelines.md) before changing anything in `resources/` or tool descriptions.
   - State concrete actions, paths, and tool usage directly; load specialized methods on demand; never leak repository architecture, build details, or developer guidelines into model context.

## Style & Tests

- TypeScript ESM, 2-space indentation, double quotes, semicolons, `.js` suffixes in relative imports, `import type` for type-only imports, strict compiler checks.
- Tests use `node:test` and `node:assert/strict` with real local files, processes, and host SDKs—no mocks, stubs, fake models, or personal credentials. Never assert prose wording in prompts or docs.
- Use concise `feat:` / `fix:` / `docs:` commit prefixes. Run `npm run check`, `npm test`, native plugin validations, and `git diff --check` before submission.
