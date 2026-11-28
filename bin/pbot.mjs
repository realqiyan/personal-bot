#!/usr/bin/env node
const args = process.argv.slice(2);
try {
  if (["init", "status", "history", "--version", "-v", "--at-least", "--json", "--workspace"].includes(args[0]) || args[0]?.startsWith("--workspace=")) {
    const { main } = await import("../lib/extension/workspace-cli.js");
    process.exitCode = await main(args);
  } else {
    const { updateForCommand, updateForWorkspace } = await import("../lib/extension/workspace-cli.js");
    const updated = args.length && !["-h", "--help", "upgrade", "update"].includes(args[0]) ? await updateForCommand(args) : undefined;
    if (updated !== undefined) {
      process.exitCode = updated;
    } else if (args[0] === "plugin") {
      const { main } = await import("../lib/plugin.js");
      await main(args.slice(1), (root, input) => updateForWorkspace(root, args, input));
    } else {
      const { main } = await import("../lib/extension/setup/cli.js");
      process.exitCode = await main(args);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
