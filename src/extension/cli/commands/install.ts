import { packageRoot } from "../../../common/paths.js";
import { getHostInstaller, listHostInstallers } from "../../../integrations/installation/installers/registry.js";
import { findExecutable, SetupProcesses } from "../../../integrations/installation/processes.js";
import type { HostInstallResult, WorkspaceInstallSummary } from "../../../model/installation.js";
import {
  executeHostInstall,
  formatInstallUsage,
  parseInstallArgs,
} from "../../../services/installation/install-service.js";
import { CliError, resolveCliWorkspace, withSignals } from "../args.js";
import type { CliCommand } from "../types.js";

function formatLine(result: HostInstallResult): string {
  const scope = result.scope ? ` (${result.scope})` : "";
  const version = result.version ? ` ${result.version}` : "";
  const head = `[${result.state}] ${result.host}${scope}${version}: ${result.detail}`;
  return result.nextStep ? `${head}\n  下一步：${result.nextStep}` : head;
}

function printHumanSummary(summary: WorkspaceInstallSummary): void {
  console.log(`工作区：${summary.workspaceRoot}`);
  for (const result of summary.results) console.log(formatLine(result));
}

export const installCommand: CliCommand = {
  name: "install",
  summary: "为指定宿主或本机全部已安装宿主安装插件（pbot install <host|all>）",
  get usage() {
    return formatInstallUsage(listHostInstallers());
  },
  updatePolicy: "none",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  async run(ctx) {
    const hosts = listHostInstallers();
    let parsed: ReturnType<typeof parseInstallArgs>;
    try {
      parsed = parseInstallArgs(ctx.args, hosts);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error), 2);
    }
    if (parsed.help) {
      console.log(formatInstallUsage(hosts));
      return 0;
    }
    const workspaceArg = ctx.workspace ?? parsed.workspace;
    const json = ctx.json || parsed.json;
    const outcome = await withSignals(
      async controller => {
        const workspace = await resolveCliWorkspace(workspaceArg, ctx.cwd);
        const processes = new SetupProcesses(controller.signal, process.env);
        const summary = await executeHostInstall({
          workspaceRoot: workspace,
          target: parsed.target!,
          hosts,
          resolveInstaller: getHostInstaller,
          createContext: (_host, explicit) => ({
            workspace,
            packageRoot,
            explicit,
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
      () => console.error("安装已取消。"),
    );
    return outcome.ok ? outcome.value : outcome.exitCode;
  },
};
