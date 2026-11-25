import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveMcpStdio } from "./extension/mcp-workers.js";

export function main(): Promise<void> {
  return serveMcpStdio();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch(error => {
    process.stderr.write("Personal Bot MCP: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
