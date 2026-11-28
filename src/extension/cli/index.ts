import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gte, valid } from "semver";
import { packageVersion } from "../../common/version.js";
import { minimumCliRelease, runUpdatedCli } from "../../integrations/installation/cli-update.js";
import { workspacePluginReleases } from "../../services/workspace/plugin-releases.js";
import { readWorkspaceConfig } from "../../services/workspace/workspace-config.js";
import { CliError, extractCommonFlags, resolveCliWorkspace } from "./args.js";
import { historyCommand } from "./commands/history.js";
import { mcpCommand } from "./commands/mcp.js";
import { pluginCommand } from "./commands/plugin.js";
import { installAntigravityCommand, setupCommand } from "./commands/setup.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { initCommand, statusCommand } from "./commands/workspace.js";
import type { CliCommand, CliContext } from "./types.js";

const commands: readonly CliCommand[] = [
  initCommand,
  statusCommand,
  historyCommand,
  upgradeCommand,
  mcpCommand,
  pluginCommand,
  setupCommand,
  installAntigravityCommand,
];

const commandIndex = new Map<string, CliCommand>();
for (const command of commands) {
  commandIndex.set(command.name, command);
  for (const alias of command.aliases ?? []) commandIndex.set(alias, command);
}

export function listCommands(): readonly CliCommand[] {
  return commands;
}

export function resolveCommand(name: string | undefined): CliCommand | undefined {
  return name ? commandIndex.get(name) : undefined;
}

export function formatRootHelp(): string {
  const lines = [
    `Personal Bot ${packageVersion}`,
    "",
    "用法：pbot <命令> [选项] [参数]",
    "",
    "命令：",
    ...commands.map(cmd => {
      const label = cmd.aliases?.length ? `${cmd.name}|${cmd.aliases.join("|")}` : cmd.name;
      return `  ${label.padEnd(22)} ${cmd.summary}`;
    }),
    "",
    "通用选项：",
    "  --workspace <目录>     指定工作区根目录（默认当前目录，适用于工作区命令）",
    "  --json                 输出 JSON（init/status/history/mcp 输出单行 JSON）",
    "  -h, --help             显示帮助（可配合具体命令使用：pbot <命令> --help）",
    "  -v, --version          显示当前 CLI 版本",
    "  --at-least <版本>      检查当前 CLI 是否满足最低版本要求",
    "",
    "支持 Linux/macOS，需要 Node.js 22.19+ 和 npm。",
  ];
  return lines.join("\n");
}

export async function updateForWorkspace(root: string, args: readonly string[], input?: string): Promise<number | undefined> {
  return runUpdatedCli(await minimumCliRelease(root, workspacePluginReleases(root)), args, input);
}

export async function updateForCommand(args: readonly string[]): Promise<number | undefined> {
  if (!args.length) return undefined;
  if (["--version", "-v", "--at-least", "--help", "-h", "help"].includes(args[0]!)) return undefined;
  const parsed = extractCommonFlags(args);
  if (parsed.help || !parsed.rest.length) return undefined;
  const [verb, ...rest] = parsed.rest;
  const command = resolveCommand(verb);
  if (!command) return undefined;
  const ctx: CliContext = {
    verb: verb!,
    rawArgs: args,
    args: rest,
    ...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
    json: parsed.json,
    cwd: process.cwd(),
  };
  const policy = typeof command.updatePolicy === "function" ? command.updatePolicy(ctx) : command.updatePolicy;
  if (policy !== "workspace") return undefined;
  const root = command.resolveWorkspaceRoot
    ? await command.resolveWorkspaceRoot(ctx)
    : await resolveCliWorkspace(ctx.workspace, ctx.cwd);
  const configuration = await readWorkspaceConfig(root);
  command.beforeUpdate?.(ctx, root, configuration);
  const initializing = command.allowUninitializedUpdate?.(ctx) ?? false;
  if (!configuration.enabled && !(initializing && !configuration.error)) return undefined;
  return updateForWorkspace(root, args);
}

export async function main(args: readonly string[]): Promise<number> {
  try {
    // Fast local probes: never touch workspace config or npm.
    if (args[0] === "--at-least") {
      const version = args[1];
      if (args.length !== 2 || !version || !valid(version)) {
        throw new CliError("用法：pbot --at-least <MAJOR.MINOR.PATCH>", 1);
      }
      return gte(packageVersion, version) ? 0 : 1;
    }
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      console.log(packageVersion);
      return 0;
    }

    const parsed = extractCommonFlags(args);
    const [verb, ...rest] = parsed.rest;

    // Top-level help or `pbot help [command]`
    if (!verb) {
      if (parsed.help || args.length === 0) {
        console.log(formatRootHelp());
        return 0;
      }
      throw new CliError(`缺少命令。\n\n${formatRootHelp()}`, 2);
    }
    if (verb === "help") {
      const target = resolveCommand(rest[0]);
      if (rest.length > 1 || (rest[0] && !target)) {
        throw new CliError(`未知命令：${rest.join(" ")}\n\n${formatRootHelp()}`, 2);
      }
      console.log(target ? target.usage : formatRootHelp());
      return 0;
    }

    const command = resolveCommand(verb);
    if (!command) {
      if (parsed.help) {
        console.log(formatRootHelp());
        return 0;
      }
      throw new CliError(`未知命令：${verb}\n\n${formatRootHelp()}`, 2);
    }

    if (parsed.help) {
      console.log(command.usage);
      return 0;
    }

    if (parsed.workspace !== undefined && !command.supportsWorkspaceFlag) {
      throw new CliError(`命令 ${command.name} 不支持 --workspace 参数。\n${command.usage}`, 2);
    }
    if (parsed.json && !command.supportsJsonFlag) {
      throw new CliError(`命令 ${command.name} 不支持 --json 参数。\n${command.usage}`, 2);
    }

    const ctx: CliContext = {
      verb,
      rawArgs: args,
      args: rest,
      ...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
      json: parsed.json,
      cwd: process.cwd(),
    };

    const policy = typeof command.updatePolicy === "function" ? command.updatePolicy(ctx) : command.updatePolicy;
    if (policy === "workspace") {
      const root = command.resolveWorkspaceRoot
        ? await command.resolveWorkspaceRoot(ctx)
        : await resolveCliWorkspace(ctx.workspace, ctx.cwd);
      const configuration = await readWorkspaceConfig(root);
      command.beforeUpdate?.(ctx, root, configuration);
      const initializing = command.allowUninitializedUpdate?.(ctx) ?? false;
      if (configuration.enabled || (initializing && !configuration.error)) {
        const updated = await updateForWorkspace(root, args);
        if (updated !== undefined) return updated;
      }
    }

    return await command.run(ctx, { updateForWorkspace });
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
