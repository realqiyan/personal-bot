import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { valid } from "semver";
import { object } from "../../../common/json.js";
import { checkStableVersion } from "../../../common/package-source.js";
import { packageRoot } from "../../../common/paths.js";
import { packageVersion } from "../../../common/version.js";
import { execCliEntry, upgradeManagedGlobalCli } from "../../../integrations/installation/cli-update.js";
import { findExecutable, SetupProcesses } from "../../../integrations/installation/processes.js";
import { getHostUpgrader } from "../../../integrations/installation/upgraders/registry.js";
import type { CliUpgradeSummary, HostUpgradeResult, WorkspaceUpgradeSummary } from "../../../model/installation.js";
import {
  executeWorkspaceUpgrade,
  parseUpgradeArgs,
  upgradeUsage,
  type WorkspaceUpgradeTarget,
} from "../../../services/installation/upgrade-service.js";
import { workspacePluginBindings } from "../../../services/workspace/plugin-releases.js";
import { CliError, resolveCliWorkspace, withSignals } from "../args.js";
import type { CliCommand } from "../types.js";

async function latestStableVersion(processes: SetupProcesses, cwd: string): Promise<string> {
  const npm = await findExecutable("npm", processes.env);
  if (!npm) throw new Error("未找到 npm，无法查询 personal-bot 最新稳定版。");
  const text = await processes.run(npm, ["view", "personal-bot@latest", "version", "engines", "--json",
    "--fetch-retries=0", "--fetch-timeout=15000"], cwd);
  const value = JSON.parse(text) as { version?: string; engines?: { node?: string } };
  if (typeof value.version !== "string") throw new Error("无法取得 personal-bot 的最新版本。");
  return checkStableVersion(value.version, value.engines?.node);
}

async function discoverWorkspaceTargets(workspace: string, requestedHosts?: readonly string[]): Promise<WorkspaceUpgradeTarget[]> {
  const bindings = workspacePluginBindings(workspace);
  const byHost = new Map<string, WorkspaceUpgradeTarget>();
  for (const [host, entry] of Object.entries(bindings)) {
    byHost.set(host, {
      host,
      currentVersion: entry.version,
      ...(entry.bindingPath ? { bindingPath: entry.bindingPath } : {}),
    });
  }
  if (!byHost.has("pi")) {
    const localPiManifest = join(workspace, ".pi", "npm", "node_modules", "personal-bot", "package.json");
    try {
      const manifest: unknown = JSON.parse(await readFile(localPiManifest, "utf8"));
      if (object(manifest) && manifest.name === "personal-bot" && typeof manifest.version === "string" && valid(manifest.version)) {
        byHost.set("pi", { host: "pi", currentVersion: manifest.version, bindingPath: localPiManifest });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (requestedHosts) {
    return requestedHosts.map(host => byHost.get(host) ?? { host });
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

function formatLine(result: HostUpgradeResult): string {
  const transition = result.previousVersion && result.version && result.previousVersion !== result.version
    ? `${result.previousVersion} → ${result.version}`
    : result.version ?? result.previousVersion ?? "";
  const scope = result.scope ? ` (${result.scope})` : "";
  const head = `[${result.state}] ${result.host}${scope}${transition ? " " + transition : ""}: ${result.detail}`;
  return result.nextStep ? `${head}\n  下一步：${result.nextStep}` : head;
}

function printHumanSummary(summary: WorkspaceUpgradeSummary): void {
  console.log(`工作区：${summary.workspaceRoot}`);
  console.log(`目标版本：${summary.targetVersion}`);
  console.log(`[${summary.cli.state}] cli ${summary.cli.previousVersion} → ${summary.cli.version}: ${summary.cli.detail}`);
  if (!summary.results.length) {
    console.log("当前工作区尚未绑定任何宿主插件。如需指定宿主，可传入 --hosts <宿主列表>。");
    return;
  }
  for (const result of summary.results) console.log(formatLine(result));
}

export const upgradeCommand: CliCommand = {
  name: "upgrade",
  aliases: ["update"],
  summary: "统一升级全局 CLI 与当前工作区已绑定的各宿主插件",
  usage: upgradeUsage,
  updatePolicy: "none",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  async run(ctx) {
    let parsed: ReturnType<typeof parseUpgradeArgs>;
    try {
      parsed = parseUpgradeArgs(ctx.args);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error), 2);
    }
    const workspaceArg = ctx.workspace ?? parsed.workspace;
    const json = ctx.json || parsed.json;
    const outcome = await withSignals(
      async controller => {
        const workspace = await resolveCliWorkspace(workspaceArg, ctx.cwd);
        const processes = new SetupProcesses(controller.signal, process.env);
        const targetVersion = parsed.version ?? await latestStableVersion(processes, ctx.cwd);

        let cli: CliUpgradeSummary;
        if (process.env.PBOT_UPGRADING_CLI === targetVersion) {
          cli = {
            state: "updated",
            previousVersion: process.env.PBOT_UPGRADING_PREVIOUS_VERSION || packageVersion,
            version: packageVersion,
            detail: `已将全局 CLI 更新到 ${packageVersion}。`,
          };
        } else {
          const cliResult = await upgradeManagedGlobalCli(targetVersion, process.env);
          if (cliResult.state === "updated" && cliResult.globalDirectory) {
            const nextEnv = {
              ...process.env,
              PBOT_UPGRADING_CLI: targetVersion,
              PBOT_UPGRADING_PREVIOUS_VERSION: packageVersion,
            };
            return execCliEntry(join(cliResult.globalDirectory, "bin", "pbot.mjs"), ctx.rawArgs, nextEnv);
          }
          cli = {
            state: cliResult.state,
            previousVersion: packageVersion,
            version: packageVersion,
            detail: cliResult.detail,
          };
        }

        const targets = await discoverWorkspaceTargets(workspace, parsed.hosts);
        const summary = await executeWorkspaceUpgrade({
          workspaceRoot: workspace,
          targetVersion,
          cli,
          targets,
          resolveUpgrader: getHostUpgrader,
          createContext: target => ({
            workspace,
            targetVersion,
            ...(target.currentVersion ? { currentVersion: target.currentVersion } : {}),
            packageRoot,
            ...(target.bindingPath ? { bindingPath: target.bindingPath } : {}),
            env: process.env,
            signal: controller.signal,
            options: { dshProfile: parsed.dshProfile },
            run: (command, args, runCwd, runOptions) => processes.run(command, args, runCwd, runOptions),
            findExecutable: name => findExecutable(name, process.env),
          }),
          signal: controller.signal,
        });

        if (json) console.log(JSON.stringify(summary, null, 2));
        else printHumanSummary(summary);
        return summary.ok ? 0 : 1;
      },
      () => console.error("升级已取消。"),
    );
    return outcome.ok ? outcome.value : outcome.exitCode;
  },
};
