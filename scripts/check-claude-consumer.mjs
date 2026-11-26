import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Pass the path of the personal-bot npm tarball.");
const tarball = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), "pbot claude consumer ")));
const consumer = join(root, "consumer"), home = join(root, "home"), workspace = join(root, "workspace"), extracted = join(root, "extracted"), enabled = join(root, "enabled");
await Promise.all([consumer, home, workspace, extracted, enabled].map(path => mkdir(path)));
const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, "data"),
  CLAUDE_CONFIG_DIR: join(home, "claude"), LANG: "C.UTF-8", CI: "true",
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  npm_config_cache: join(root, "cache"), npm_config_engine_strict: "true" };
try {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, env, stdio: "inherit", timeout: 180_000 });
  const packed = join(consumer, "node_modules/personal-bot");
  const require = createRequire(join(packed, "package.json"));
  for (const name of ["@earendil-works/pi-coding-agent", "@deepseek-ai/dsh", "@deepseek-ai/dsh-agent", "@anthropic-ai/claude-agent-sdk", "typebox", "@modelcontextprotocol/sdk"]) {
    assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
  const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(join(packed, ".claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(join(packed, ".claude-plugin/marketplace.json"), "utf8"));
  const hooks = JSON.parse(await readFile(join(packed, "hooks/hooks.json"), "utf8"));
  assert.equal(plugin.version, manifest.version);
  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(marketplace.plugins[0].source.version, manifest.version);
  assert.equal(plugin.types, undefined);
  assert.equal(hooks.modules, undefined);
  for (const path of [...plugin.skills, "lib/claude.js", "lib/extension/mcp.js", "lib/extension/acp-worker.js", ".mcp.json", "resources/skills/.claude-plugin/plugin.json"]) {
    await stat(resolve(packed, path));
  }
  const validation = JSON.parse(execFileSync(process.env.PBOT_CLAUDE_COMMAND ?? "claude",
    ["plugin", "validate", "--json", join(packed, ".claude-plugin/plugin.json")],
    { cwd: workspace, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
  assert.equal(validation.success, true, JSON.stringify(validation));
  const version = execFileSync(process.execPath, [join(packed, "bin/pbot.mjs"), "--version"],
    { cwd: workspace, env, encoding: "utf8" }).trim();
  assert.equal(version, manifest.version);
  const cli = args => JSON.parse(execFileSync(process.execPath, [join(packed, "lib/claude.js"), ...args],
    { cwd: workspace, env, encoding: "utf8", timeout: 30_000 }));
  const status = cli(["status"]);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted], { cwd: workspace, env, timeout: 30_000 });
  const raw = join(extracted, "package");
  await assert.rejects(stat(join(raw, "node_modules")), { code: "ENOENT" });
  await assert.rejects(stat(join(raw, "npm-shrinkwrap.json")), { code: "ENOENT" });
  const rawStatus = JSON.parse(execFileSync(process.execPath, [join(raw, "lib/claude.js"), "status"],
    { cwd: workspace, env, encoding: "utf8", timeout: 30_000 }));
  assert.equal(rawStatus.version, manifest.version);
  assert.equal(rawStatus.configuration.enabled, false);
  assert.equal(rawStatus.workspaceRoot, workspace);
  assert.equal(status.version, manifest.version);
  assert.equal(status.configuration.enabled, false);
  assert.equal(status.workspaceRoot, workspace);
  const hook = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.command, "node");
  const args = hook.args.map(value => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", raw));
  const result = JSON.parse(execFileSync(process.execPath, args, { cwd: workspace, env, encoding: "utf8", timeout: 10_000,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: workspace }) }));
  assert.deepEqual(result, {});
  const expansion = hooks.hooks.UserPromptExpansion[0].hooks[0];
  const blocked = JSON.parse(execFileSync(expansion.command, expansion.args.map(value => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", raw)),
    { cwd: workspace, env, encoding: "utf8", timeout: 10_000,
      input: JSON.stringify({ hook_event_name: "UserPromptExpansion", cwd: workspace, expansion_type: "slash_command", command_name: "personal-bot:project-maintenance" }) }));
  assert.equal(blocked.decision, "block");
  await mkdir(join(enabled, ".pbot"));
  await writeFile(join(enabled, ".pbot/config.json"), JSON.stringify({ enabled: true }));
  const enabledPrompt = JSON.parse(execFileSync(process.execPath, args,
    { cwd: enabled, env, encoding: "utf8", timeout: 30_000,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: enabled }) }));
  const environment = JSON.parse(enabledPrompt.hookSpecificOutput.additionalContext.split("\n\n").at(-1));
  assert.deepEqual(environment, { host: "claude", workspaceRoot: enabled, resourceRoot: join(raw, "resources") + "/" });
  assert.equal(enabledPrompt.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  await assert.rejects(stat(join(workspace, ".pbot")), { code: "ENOENT" });
  console.log(`Packed Claude command hooks, native plugin validation and standalone CLI passed; extracted Claude hooks and CLI ran without node_modules: personal-bot@${version}, Node ${process.version}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
