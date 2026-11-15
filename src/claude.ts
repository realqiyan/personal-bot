import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { claudeCommand, claudeHook } from "./extension/claude-hooks.js";

export async function main(args: readonly string[]): Promise<void> {
  if (args[0] === "hook") {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += String(chunk);
    process.stdout.write(JSON.stringify(await claudeHook(JSON.parse(input))) + "\n");
  } else process.stdout.write(JSON.stringify(await claudeCommand(args, process.cwd()), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write("Personal Bot: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
