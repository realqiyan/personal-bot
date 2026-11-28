import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gte, valid } from "semver";
import { requireThat } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import { getPluginHost, pluginMcpWorkspaceRoot } from "../../integrations/hosts/plugin-registry.js";
import { minimumCliRelease, runUpdatedCli } from "../../integrations/installation/cli-update.js";
import { resolveWorkspace } from "../../integrations/installation/workspace.js";
import { parseHistoryCommand, type ParsedHistoryCommand } from "../../services/history/summary-command.js";
import { workspacePluginDrift, workspacePluginReleases } from "../../services/workspace/plugin-releases.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { initializeWorkspace } from "../../services/workspace/workspace-preparation.js";

const usage = `pbot init | status [--workspace <目录>] [--json]
pbot history status | list
pbot history summary [维度...] [--force] [--backend <acp>] [--model <模型>] [--thinking <级别>]
pbot history migrate [--dry-run]
pbot history search [关键词] [--host <来源>] [--dimension <维度>] [--session-id <ID>] [--from <时间>] [--to <时间>] [--offset N] [--limit N]
pbot history read <节点ID> [--host <来源>] [--offset N] [--limit N] [--children-offset N]
所有工作区命令支持 --workspace <目录> 和 --json。默认工作区为当前目录。`;

function workspaceArgs(args: readonly string[]) {
  const rest: string[] = [];
  let workspace: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--") { rest.push(...args.slice(index)); break; }
    if (token === "--workspace" || token.startsWith("--workspace=")) {
      requireThat(workspace === undefined, "--workspace 只能指定一次。");
      workspace = token === "--workspace" ? args[++index] : token.slice("--workspace=".length);
      requireThat(workspace && !workspace.startsWith("-"), "--workspace 需要目录。");
    } else if (token === "--json") json = true;
    else rest.push(token);
  }
  return { workspace, json, rest };
}

function historyAction(args: string[]): ParsedHistoryCommand {
  const [action, ...rest] = args;
  if (action !== "search" && action !== "read") return parseHistoryCommand(args);
  const string = { type: "string" } as const;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      host: string, offset: string, limit: string,
      ...(action === "search" ? { dimension: string, "session-id": string, from: string, to: string } : { "children-offset": string }),
    },
  });
  requireThat(positionals.length <= 1 && (action === "search" || positionals[0]), usage);
  const input: Record<string, unknown> = { action };
  if (positionals.length) input[action === "search" ? "query" : "id"] = positionals[0];
  for (const [key, value] of Object.entries(values)) {
    if (["offset", "limit", "children-offset"].includes(key)) {
      requireThat(typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)), "--" + key + " 需要非负整数。");
      input[key === "children-offset" ? "childrenOffset" : key] = Number(value);
    } else input[key === "session-id" ? "sessionId" : key] = value;
  }
  return { kind: "query", input };
}

export async function updateForWorkspace(root: string, args: string[], input?: string): Promise<number | undefined> {
  return runUpdatedCli(await minimumCliRelease(root, workspacePluginReleases(root)), args, input);
}

/** Hook workspaces are resolved by the adapter from the event on stdin. */
export async function updateForCommand(args: string[]): Promise<number | undefined> {
  if (args[0] === "plugin" && args[2] === "hook") return undefined;
  const cwd = process.cwd();
  let workspace: string;
  if (args[0] === "plugin" && args[1]) {
    workspace = await getPluginHost(args[1])?.resolveRoot(cwd) ?? cwd;
  } else if (args[0] === "mcp" && args.length === 1) {
    workspace = pluginMcpWorkspaceRoot() ?? cwd;
  } else {
    workspace = workspaceArgs(args).workspace ?? cwd;
  }
  const root = await resolveWorkspace(workspace, cwd, homedir());
  const configuration = await readWorkspaceConfig(root);
  const initializing = args[0] === "plugin" && args[2] === "init" && args.length === 3;
  if (!configuration.enabled && !(initializing && !configuration.error)) return undefined;
  return updateForWorkspace(root, args);
}

export async function main(args: string[]): Promise<number> {
  if (args[0] === "--at-least") {
    const version = args[1];
    requireThat(args.length === 2 && version && valid(version), "用法：pbot --at-least <MAJOR.MINOR.PATCH>");
    return gte(packageVersion, version) ? 0 : 1;
  }
  const { workspace, json, rest } = workspaceArgs(args);
  const [verb, ...tail] = rest;
  const delimiter = rest.indexOf("--");
  if (rest.slice(0, delimiter < 0 ? rest.length : delimiter).some(token => token === "--help" || token === "-h")) {
    console.log(usage);
    return 0;
  }
  requireThat(verb === "history" || ["init", "status", "--version", "-v"].includes(verb ?? "") && !tail.length, usage);
  if (verb === "--version" || verb === "-v") { console.log(packageVersion); return 0; }
  const cwd = process.cwd();
  const root = await resolveWorkspace(workspace ?? cwd, cwd, homedir());
  let configuration = await readWorkspaceConfig(root);
  if (verb === "init" && configuration.error) throw new Error(configuration.error);
  if (verb === "history") {
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
    requireThat(workspaceFeatures(configuration).history, "当前工作区已停用历史功能（features.history: false）。");
  }
  const checkRelease = configuration.enabled || verb === "init";
  const plugins = checkRelease ? workspacePluginReleases(root) : {};
  const required = checkRelease ? await minimumCliRelease(root, plugins) : undefined;
  const updated = await runUpdatedCli(required, args);
  if (updated !== undefined) return updated;
  const print = (result: unknown) => console.log(JSON.stringify(result, null, json ? undefined : 2));
  if (verb === "init") {
    await mkdir(root, { recursive: true });
    await initializeWorkspace(root);
    configuration = await readWorkspaceConfig(root);
  }
  requireThat((await stat(root)).isDirectory(), "工作区必须是目录。");
  if (verb !== "history") {
    const drift = workspacePluginDrift(plugins);
    print({
      workspaceRoot: root,
      version: packageVersion,
      plugins,
      outOfSync: drift.outOfSync,
      minimumCliVersion: required ?? null,
      configuration,
    });
    return configuration.error ? 1 : 0;
  }
  const command = historyAction(tail);
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => { exitCode = 130; controller.abort(); };
  const terminate = () => { exitCode = 143; controller.abort(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const { runHistoryCommand } = await import("../history/command.js");
    const result = await runHistoryCommand({ root, features: workspaceFeatures(configuration) }, command, controller.signal, {
      start: backend => console.error("历史摘要生成中 (" + backend + ")"),
      update: event => console.error(`${event.dimension} ${event.completed}/${event.total}`),
    });
    print(result);
    if ("backend" in result && result.dimensions.some(dimension => dimension.failed.length)) return 1;
    if ("errors" in result && (result.errors.length || result.skipped.length)) return 1;
    return 0;
  } catch (error) {
    if (!exitCode) throw error;
    console.error("历史操作已取消。");
    return exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
