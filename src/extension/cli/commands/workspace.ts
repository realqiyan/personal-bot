import { mkdir, stat } from "node:fs/promises";
import { requireThat } from "../../../common/validation.js";
import { packageVersion } from "../../../common/version.js";
import { minimumCliRelease } from "../../../integrations/installation/cli-update.js";
import { workspacePluginDrift, workspacePluginReleases } from "../../../services/workspace/plugin-releases.js";
import { readWorkspaceConfig } from "../../../services/workspace/workspace-config.js";
import { initializeWorkspace } from "../../../services/workspace/workspace-preparation.js";
import { printJson, requireNoExtraArgs, resolveCliWorkspace } from "../args.js";
import type { CliCommand } from "../types.js";

const initUsage = "用法：pbot init [--workspace <目录>] [--json]\n初始化共享工作区资料并启用 Personal Bot。";
const statusUsage = "用法：pbot status [--workspace <目录>] [--json]\n查看工作区根目录、CLI 版本、各宿主插件版本、同步状态与配置。";

async function reportWorkspaceStatus(root: string, compact: boolean, checkRelease: boolean): Promise<number> {
  const configuration = await readWorkspaceConfig(root);
  const active = checkRelease || configuration.enabled;
  const plugins = active ? workspacePluginReleases(root) : {};
  const required = active ? await minimumCliRelease(root, plugins) : undefined;
  const drift = workspacePluginDrift(plugins);
  printJson({
    workspaceRoot: root,
    version: packageVersion,
    plugins,
    outOfSync: drift.outOfSync,
    minimumCliVersion: required ?? null,
    configuration,
  }, compact);
  return configuration.error ? 1 : 0;
}

export const initCommand: CliCommand = {
  name: "init",
  summary: "初始化共享资料并启用工作区",
  usage: initUsage,
  updatePolicy: "workspace",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  allowUninitializedUpdate: () => true,
  beforeUpdate(ctx, _root, configuration) {
    requireNoExtraArgs(ctx.args, initUsage);
    if (configuration.error) throw new Error(configuration.error);
  },
  async run(ctx) {
    requireNoExtraArgs(ctx.args, initUsage);
    const root = await resolveCliWorkspace(ctx.workspace, ctx.cwd);
    const existing = await readWorkspaceConfig(root);
    if (existing.error) throw new Error(existing.error);
    await mkdir(root, { recursive: true });
    await initializeWorkspace(root);
    requireThat((await stat(root)).isDirectory(), "工作区必须是目录。");
    return reportWorkspaceStatus(root, ctx.json, true);
  },
};

export const statusCommand: CliCommand = {
  name: "status",
  summary: "查看工作区状态、插件版本与配置",
  usage: statusUsage,
  updatePolicy: "workspace",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  beforeUpdate(ctx) {
    requireNoExtraArgs(ctx.args, statusUsage);
  },
  async run(ctx) {
    requireNoExtraArgs(ctx.args, statusUsage);
    const root = await resolveCliWorkspace(ctx.workspace, ctx.cwd);
    requireThat((await stat(root)).isDirectory(), "工作区必须是目录。");
    return reportWorkspaceStatus(root, ctx.json, false);
  },
};
