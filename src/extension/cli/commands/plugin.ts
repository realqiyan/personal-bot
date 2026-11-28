import { requireThat } from "../../../common/validation.js";
import { getPluginHost, listPluginHosts, pluginHosts } from "../../../integrations/hosts/plugin-registry.js";
import { runPluginHost } from "../../hosts/plugin-runtime.js";
import { resolveCliWorkspace } from "../args.js";
import type { CliCommand } from "../types.js";

function pluginUsage(): string {
  return `用法：pbot plugin <${listPluginHosts().join("|")}> hook|init|status\n运行插件宿主命令或无状态 hook。`;
}

export const pluginCommand: CliCommand = {
  name: "plugin",
  summary: "运行插件宿主命令（hook / init / status）",
  get usage() { return pluginUsage(); },
  updatePolicy: ctx => (ctx.args[1] === "hook" ? "hook" : "workspace"),
  allowUninitializedUpdate: ctx => ctx.args[1] === "init" && ctx.args.length === 2,
  async resolveWorkspaceRoot(ctx) {
    const host = ctx.args[0];
    const resolved = host ? await getPluginHost(host)?.resolveRoot(ctx.cwd) : undefined;
    return resolveCliWorkspace(resolved ?? ctx.cwd, ctx.cwd);
  },
  async run(ctx, helpers) {
    const [host, ...rest] = ctx.args;
    const adapter = host ? pluginHosts.get(host) : undefined;
    requireThat(adapter, pluginUsage());
    const previousCode = process.exitCode;
    process.exitCode = undefined;
    await runPluginHost(adapter, rest, (root, input) => helpers.updateForWorkspace(root, ctx.rawArgs, input));
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = previousCode;
    return exitCode;
  },
};
