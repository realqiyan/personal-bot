# Repository Guidelines

## Structure

Personal Bot connects knowledge, research, and action. It provides a workspace-scoped Pi extension, a native dsh Host/Web integration, and a standalone Pi installation CLI.

- `src/pbot.ts`: Pi dependency assembly and registration.
- `src/dsh.ts`: dsh Host assembly; `src/ui/dsh/index.ts` is the native Web entry.
- `src/tools/`: complete tool contracts, execution adapters, and explicit tool lists.
- `src/services/`: business rules, state changes, and operation order.
- `src/model/`: business data types and narrow capability contracts; no business behavior or host SDK types.
- `src/integrations/`: native Pi/dsh sessions, Python environment activation, and process execution.
- `src/storage/`: atomic JSON and subagent file storage.
- `src/extension/`: commands, events, activation, and resource lifetime.
- `src/ui/`: confirmation queue, dialogs, and agent display.
- `src/common/`: shared JSON, validation, file, and package-path helpers.
- `resources/`: roles, skills, and references.
- `tests/`: necessary Node tests using real local logic and the Pi/dsh SDKs.
- `python/`: locked calculation dependencies, usage guidance, and native-library integration tests.
- `docs/`: current architecture and validation limits.
- `scripts/`: build helpers and shared Python venv preparation.
- `bin/pbot.mjs`: standalone installation CLI launcher.
- `lib/`: generated CLI, dsh Host, and Web artifacts shipped in the npm package. Do not edit generated files.
- `dist/`: generated test imports. Do not edit generated files.

Keep the top-level layers. Group related files by domain within a layer: services use `agents/`, `workspace/`, `history/`, and `installation/`; integrations keep host protocols in `pi/` and `dsh/`, and installation adapters in `installation/`; tool contracts stay beside their domain tools. Tests use domain subdirectories under `tests/`.

Read `docs/architecture-guidelines.md` for general design requirements. Read `docs/technical-design.md` for module boundaries and `docs/validation.md` for validation limits. Read `docs/capability-design.md` before changing native tool integration or execution boundaries. Personal Bot does not create or read workspace activation state, maintain a workspace format, or provide workspace upgrades. Leave existing user data, historical records, and backups untouched. Do not import old configuration automatically. Delete unused repository code. Never delete user workspaces or historical trading records.

Release versions use `MAJOR.MINOR.PATCH` from `package.json`; bundled components share that release. Subagent compatibility follows the minor line before 1.0, then the major line. Keep persisted subagent contracts unchanged within a line; do not add storage or upgrade version counters.

## Commands

Use Linux with Node.js 24.9 or later for dual-host development and complete acceptance. Pi consumers and the standalone CLI retain Node.js 22.19+. dsh currently requires Node.js 24.9+; check the current release's engines when updating. User installation instructions follow the latest dsh release, without an exact version pin. Declare the minimum host version in engines.dsh and host-provided dsh SDKs as "*" optional peers; keep exact development dependencies and the lockfile for reproducible checks, and record the versions actually tested. The current development baseline is 0.2.2-rc.1. Computation requires Python 3.11+.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: check TypeScript and dependency boundaries without emitting files.
- `npm run check:dependencies`: check imports and cycles with dependency-cruiser.
- `npm run build`: compile test imports into dist and build the installation CLI and dsh Host/Web artifacts into lib.
- `npm run build:cli`: clean lib and compile the standalone installation CLI.
- `npm run build:dsh`: compile the dsh Host and build the native Web client into lib; run after build:cli when preparing the full package.
- `npm test`: build and run Node tests serially.
- `npm pack --dry-run`: inspect package contents.

Pi loads the source extension with jiti. The standalone CLI uses prebuilt lib files and must start without Pi. Declare host-provided packages as optional peers, not runtime dependencies. Installation adapters use the detected host's SDK in a separate process; do not bundle a second Pi SDK or create an installation registry.

## Development Principles

- Use the simplest solution that meets an established requirement.
- Prefer each host’s native tools, UI, resource discovery, configuration, and sessions over custom equivalents. Keep Pi and dsh native configuration and session ownership separate; share business services and materials.
- Define roles in documents and professional methods in skills.
- Keep business decisions separate from host integration. Services receive plain data and narrow capabilities, not complete host contexts.
- Keep tool inputs, outputs, schemas, and execution adapters together. Commands and tools call the same services.
- Keep state changes in their owning services. Bind tools to one workspace instance and reject stale calls after close.
- Keep each module focused. Do not add unused interfaces or forwarding layers.
- Use narrow strategies for existing protocol differences. Keep approval, persistence, and state rules in their owning services. Register implementations explicitly; do not add dynamic plugin discovery.
- Do not create a plugin platform, fixed research workflow, second main agent, or workspace upgrade system.
- Let each host own extension activation; do not add another workspace enablement switch.
- pbot is a trusted-model personal assistant. Use native CLI commands, help, and concise workspace guides; use each host's native MCP configuration, discovery, authentication, and tools.
- Do not recreate a provider catalog, parameter bindings, private MCP client, per-tool permission table, or generic call wrapper.
- Follow the user's task and existing agreements. Do not add generic evidence, permission, approval, independent-review, or acceptance workflows to model instructions. Keep concrete operational requirements in the relevant tool or method. Hard execution limits belong to credentials, the external service, or a restricted environment, not a bypassable Personal Bot tool gate.
- All pbot workspaces share one user-scoped Python venv. Loading Personal Bot automatically prepares locked dependencies and activates the venv in the owning Pi or dsh process; errors are reported without changing system Python. dsh workspaces share the Host component's activation lifetime. Python uses native Bash and the project working directory. Setup does not execute research or create run records. Do not add a calculation tool, unified library wrapper, or implicit market rules. Project builds and tests use their declared environment.
- Do not claim host isolation for Bash, Python, or extensions.
- Do not add file hash verification in code, tests, builds, or checks.

## Model Instructions

Read and follow [Model Instruction Guidelines](docs/model-instruction-guidelines.md) before changing agent-visible prompts, roles, skills, references, templates, tool descriptions, generated messages, or their loading. Inspect actual first-task context in both hosts, state concrete actions directly, keep useful directory and operational details, and load specialized methods only when needed. Fix loading and behavior defects in code; do not compensate with extra prompt rules or tests of wording. Current loading behavior is documented in [Model Context](docs/model-context.md).

## Style

Use TypeScript ESM, two-space indentation, double quotes, semicolons, and `.js` suffixes in relative imports. Use `import type` for type-only imports. Keep strict compiler checks.

Use camelCase for variables and functions, PascalCase for types, and kebab-case for multiword filenames. Keep host details in their integration.

## Tests

Use `node:test` and `node:assert/strict`. Import compiled modules from dist. Test concrete correctness risks, not coverage counts or implementation structure.

Do not use mocks, stubs, fake models, simulated providers, real trades, or personal credentials. Use actual local files, processes, calculations, and Pi/dsh SDK behavior.

Do not test documentation, prompt text, labels, or message wording. Parsing and serialization may verify structured values when they form the logic contract.

Real model and external provider acceptance requires an approved environment. Record remaining gaps; local tests do not prove those behaviors.

## Submission

Use concise `feat:` or `fix:` commit prefixes. Keep changes focused.

Update design and usage docs when behavior changes. Run `npm run check`, `npm test`, and `git diff --check` before submission. Keep credentials, runtime databases, and local configuration out of commits.
