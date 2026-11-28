#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (!process.env.PBOT_ACP_PI_COMMAND) throw new Error("Missing Personal Bot Pi ACP launch context");

let args;
if (process.env.PBOT_SUMMARY_WORKER === "1") {
  // Minimal pure-text Pi runtime for history summarization: no tools, extensions, skills, templates, or AGENTS.md.
  args = [
    ...process.argv.slice(2),
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ];
} else {
  // pi-acp supplies RPC arguments. Add the managed member's native resource options.
  const directory = process.env.PBOT_SUBAGENT_DIR;
  if (!directory) throw new Error("Missing Personal Bot Pi ACP launch context");
  const { options } = JSON.parse(readFileSync(join(directory, "descriptor.json"), "utf8"));
  args = [...process.argv.slice(2), "--extension", fileURLToPath(new URL("../lib/extension/hosts/pi/acp-member.js", import.meta.url))];
  if (options.noExtensions !== false) args.push("--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", "builtin:tool-search");
  if (options.noSkills) args.push("--no-skills");
  if (options.noPromptTemplates) args.push("--no-prompt-templates");
  if (options.noContextFiles) args.push("--no-context-files");
  if (options.tools) args.push("--tools", options.tools.join(","));
}

const child = spawn(process.env.PBOT_ACP_PI_COMMAND, args, { stdio: "inherit", env: process.env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
for (const termination of ["SIGINT", "SIGTERM"]) process.on(termination, () => child.kill(termination));
child.on("exit", (code, termination) => { process.exitCode = termination ? 1 : code ?? 1; });
