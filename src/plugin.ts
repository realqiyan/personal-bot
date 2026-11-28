import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requireThat } from "./common/validation.js";
import { runPluginHost, type ReplayPluginHook } from "./extension/hosts/plugin-runtime.js";
import { listPluginHosts, pluginHosts } from "./integrations/hosts/plugin-registry.js";

export async function main(args: readonly string[], replayHook?: ReplayPluginHook): Promise<void> {
  const [host, ...rest] = args;
  const adapter = host ? pluginHosts.get(host) : undefined;
  requireThat(adapter, `用法：node <插件目录>/lib/plugin.js <${listPluginHosts().join("|")}> hook|init|status`);
  await runPluginHost(adapter, rest, replayHook);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write("Personal Bot: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
