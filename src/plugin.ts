import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requireThat } from "./common/validation.js";
import { runPluginHost } from "./extension/plugin-runtime.js";
import { antigravityAdapter } from "./integrations/hosts/antigravity.js";
import { claudeAdapter } from "./integrations/hosts/claude.js";
import type { PluginHostAdapter, PluginHostId } from "./model/plugin-host.js";

const adapters: Record<PluginHostId, PluginHostAdapter> = {
  claude: claudeAdapter,
  antigravity: antigravityAdapter,
};

export async function main(args: readonly string[]): Promise<void> {
  const [host, ...rest] = args;
  requireThat(host === "claude" || host === "antigravity", "用法：node <插件目录>/lib/plugin.js <claude|antigravity> hook|init|status");
  await runPluginHost(adapters[host], rest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write("Personal Bot: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
