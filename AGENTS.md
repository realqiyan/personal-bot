# Repository Guidelines

## Structure

Personal Bot connects knowledge, research, and action. It is currently implemented as a workspace-scoped Pi extension package, not a standalone CLI.

- `src/pbot.ts`: dependency assembly and registration.
- `src/tools/`: complete tool contracts, execution adapters, and explicit tool lists.
- `src/services/`: business rules, state changes, and operation order.
- `src/model/`: data-only business classes; no business behavior or Pi types.
- `src/integrations/`: Pi sessions, Python environment activation, and process execution.
- `src/storage/`: atomic JSON and subagent file storage.
- `src/extension/`: commands, events, activation, and resource lifetime.
- `src/ui/`: confirmation queue, dialogs, and agent display.
- `src/common/`: shared JSON, validation, file, and package-path helpers.
- `resources/`: roles, skills, and references.
- `tests/`: necessary Node tests using real local logic and the Pi SDK.
- `python/`: locked calculation dependencies, usage guidance, and native-library integration tests.
- `docs/`: current architecture and validation limits.
- `scripts/`: build helpers and shared Python venv preparation.
- `dist/`: generated test imports. Do not edit generated files.

Keep the top-level layers. Group related files by domain within a layer: services use `agents/` and `workspace/`; integrations use `pi/` for session integration; tool contracts stay beside their domain tools. Tests use domain subdirectories under `tests/`.

Read `docs/architecture-guidelines.md` for general design requirements. Read `docs/technical-design.md` for module boundaries and `docs/validation.md` for validation limits. Read `docs/capability-design.md` before changing native tool integration or execution boundaries. Personal Bot does not create or read workspace activation state, maintain a workspace format, or provide workspace upgrades. Leave existing user data, historical records, and backups untouched. Do not import old configuration automatically. Delete unused repository code. Never delete user workspaces or historical trading records.

Release versions use `MAJOR.MINOR.PATCH` from `package.json`; bundled components share that release. Subagent compatibility follows the minor line before 1.0, then the major line. Keep persisted subagent contracts unchanged within a line; do not add storage or upgrade version counters.

## Commands

Use Linux with Node.js 22.19 or later. Computation requires Python 3.11+.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run check`: check TypeScript and dependency boundaries without emitting files.
- `npm run check:dependencies`: check imports and cycles with dependency-cruiser.
- `npm run build`: compile test imports into dist.
- `npm test`: build and run Node tests serially.
- `npm pack --dry-run`: inspect package contents.

Pi loads the source extension with jiti. The package does not require compiled JavaScript at runtime. Declare host-provided packages as peers, not runtime dependencies.

## Development Principles

- Use the simplest solution that meets an established requirement.
- Prefer Pi tools, UI, resource discovery, configuration, and sessions over custom equivalents.
- Define roles in documents and professional methods in skills.
- Keep business decisions separate from host integration. Services receive plain data and narrow capabilities, not complete Pi contexts.
- Keep tool inputs, outputs, schemas, and execution adapters together. Commands and tools call the same services.
- Keep state changes in their owning services. Bind tools to one workspace instance and reject stale calls after close.
- Keep each module focused. Do not add unused interfaces or forwarding layers.
- Use narrow strategies for existing protocol differences. Keep approval, persistence, and state rules in their owning services. Register implementations explicitly; do not add dynamic plugin discovery.
- Do not create a plugin platform, fixed research workflow, second main agent, or workspace upgrade system.
- Let Pi own extension activation; do not add another workspace enablement switch.
- pbot is a trusted-model personal assistant. Use native CLI commands, help, and concise workspace guides; use Pi native MCP configuration, discovery, authentication, and tools.
- Do not recreate a provider catalog, parameter bindings, private MCP client, per-tool permission table, or generic call wrapper. Native capabilities do not imply user authorization or business success.
- Keep task authorization and result verification in the roles and professional methods. Hard execution limits belong to credentials, the external service, or a restricted environment, not a bypassable Personal Bot tool gate.
- All pbot workspaces share one user-scoped Python venv. Loading Personal Bot automatically prepares locked dependencies and activates the venv for this Pi process; errors are reported without changing system Python. Python uses native Bash and the project working directory. Setup does not execute research or create run records. Do not add a calculation tool, unified library wrapper, or implicit market rules. Project builds and tests use their declared environment.
- Do not claim host isolation for Bash, Python, or extensions.
- Do not add file hash verification in code, tests, builds, or checks.

## Style

Use TypeScript ESM, two-space indentation, double quotes, semicolons, and `.js` suffixes in relative imports. Use `import type` for type-only imports. Keep strict compiler checks.

Use camelCase for variables and functions, PascalCase for types, and kebab-case for multiword filenames. Keep host details in their integration.

## Tests

Use `node:test` and `node:assert/strict`. Import compiled modules from dist. Test concrete correctness risks, not coverage counts or implementation structure.

Do not use mocks, stubs, fake models, simulated providers, real trades, or personal credentials. Use actual local files, processes, calculations, and Pi SDK behavior.

Do not test documentation, prompt text, labels, or message wording. Parsing and serialization may verify structured values when they form the logic contract.

Real model and external provider acceptance requires an approved environment. Record remaining gaps; local tests do not prove those behaviors.

## Submission

Use concise `feat:` or `fix:` commit prefixes. Keep changes focused.

Update design and usage docs when behavior changes. Run `npm run check`, `npm test`, and `git diff --check` before submission. Keep credentials, runtime databases, and local configuration out of commits.
