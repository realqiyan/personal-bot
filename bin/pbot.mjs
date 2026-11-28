#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "plugin") {
  const { main } = await import("../lib/plugin.js");
  try { await main(args.slice(1)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
} else {
  const { main } = await import("../lib/extension/setup/cli.js");
  process.exitCode = await main(args);
}
