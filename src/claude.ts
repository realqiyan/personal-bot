import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runPluginHost } from "./extension/hosts/plugin-runtime.js";
import { claudeAdapter } from "./integrations/hosts/claude/adapter.js";

export function main(args: readonly string[]): Promise<void> {
  return runPluginHost(claudeAdapter, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write("Personal Bot: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
