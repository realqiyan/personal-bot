import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeOptions } from "../../dist/integrations/acp/claude.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

test("Claude native settings supply the default effort and explicit effort stays scoped to the invocation", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-claude-settings-")), config = join(root, "config");
  await mkdir(config);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(async () => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const stored = JSON.stringify({ model: "sonnet", effortLevel: "high", env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } });
  await writeFile(join(config, "settings.json"), stored);
  const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const command = { command: entry, args: [] };
  const defaults = await claudeOptions(command, root);
  assert.equal(defaults.thinking, "max"); assert.equal(defaults.options.effort, "max");
  assert.equal(defaults.options.settings, undefined);
  assert.deepEqual(await claudeOptions(command, root, "default"), defaults);
  assert.deepEqual(await claudeOptions({ command: process.execPath, args: [entry] }, root), defaults);
  const explicit = await claudeOptions(command, root, "low");
  assert.equal(explicit.thinking, "low"); assert.equal(explicit.options.effort, "low");
  assert.deepEqual(explicit.options.settings, { env: { CLAUDE_CODE_EFFORT_LEVEL: "low" } });
  await assert.rejects(claudeOptions(command, root, "off"));
  assert.equal(await readFile(join(config, "settings.json"), "utf8"), stored);
});

test("Claude discovers bundled and project skills through its native catalog without loading pbot roles as agents", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-claude-skills-")), config = join(root, "config");
  await mkdir(config);
  await mkdir(join(root, ".claude/skills/local-check"), { recursive: true });
  await writeFile(join(root, ".claude/skills/local-check/SKILL.md"), "---\nname: local-check\ndescription: Inspect local files\n---\nRead the task inputs.\n");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(async () => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const configuration = await claudeOptions({ command: entry, args: [] }, root);
  let end;
  const pending = new Promise(resolve => { end = resolve; });
  let exited;
  // Native initialization discovers resources before any user input or provider request.
  const session = query({ prompt: (async function* () { await pending; })(), options: {
    ...configuration.options, cwd: root, settingSources: ["project"], persistSession: false,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1" },
    spawnClaudeCodeProcess: options => {
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: "pipe" });
      exited = new Promise(resolve => child.once("close", resolve));
      child.stderr.resume();
      return child;
    },
  } });
  const close = () => { session.close(); end(); };
  t.signal.addEventListener("abort", close, { once: true });
  try {
    const commands = await session.supportedCommands();
    assert.deepEqual(commands.filter(command => command.name.startsWith("personal-bot:")).map(command => command.name).sort(),
      ["personal-bot:project-maintenance", "personal-bot:provider-connections"]);
    assert.equal(commands.filter(command => command.name === "local-check").length, 1);
    assert.equal((await session.supportedAgents()).some(agent => agent.name.startsWith("personal-bot:")), false);
  } finally {
    t.signal.removeEventListener("abort", close); close();
    // Query.close() starts shutdown; wait for the native writer before removing its config.
    await exited;
  }
});

test("closing a real ACP connection leaves no referenced grace timer in the client process", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-acp-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../../dist/integrations/acp/connection.js", import.meta.url).href;
  const command = fileURLToPath(new URL("../../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
  const script = `import { openAcp } from ${JSON.stringify(moduleUrl)};
    const connection = await openAcp({host:"acp",backend:"dsh",command:${JSON.stringify(command)},args:["--profile","acp"],sessionId:null},${JSON.stringify(root)},process.env,
      {update(){},permission:async()=>({outcome:{outcome:"cancelled"}})},new AbortController().signal);
    await connection.close();
    process.stdout.write(JSON.stringify({closedAt:Date.now()})+"\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DSH_HOME: join(root, "home"), DSH_AGENTS_HOME: join(root, "agents") }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const exitedAt = Date.now();
  assert.equal(code, 0, stderr);
  const closed = JSON.parse(stdout.trim());
  assert.ok(exitedAt - closed.closedAt < 1000, `client remained alive for ${exitedAt - closed.closedAt}ms after close`);
});
