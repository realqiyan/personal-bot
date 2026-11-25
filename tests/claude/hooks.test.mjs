import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resourceRoot } from "../../dist/common/paths.js";

const exec = promisify(execFile), entry = resolve("dist/claude.js");
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot plain claude hooks ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), cwd = join(workspace, "nested");
  await mkdir(cwd, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), CLAUDE_PROJECT_DIR: workspace,
    CLAUDE_CONFIG_DIR: join(root, "config") };
  const run = async (args, input) => {
    const child = exec(process.execPath, [entry, ...args], { cwd, env, timeout: 30_000 });
    child.child.stdin.end(input ? JSON.stringify(input) : undefined);
    const output = await child;
    return JSON.parse(output.stdout);
  };
  const hook = (hook_event_name, values = {}) => run(["hook"], { hook_event_name, cwd, ...values });
  return { root, workspace, cwd, env, run, hook };
}

test("disabled command hooks use the bound root and leave workspace and user data untouched", async t => {
  const { root, workspace, env, run, hook } = await fixture(t);
  await mkdir(join(root, ".pbot"));
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true }));
  const status = await run(["status"]);
  assert.equal(status.workspaceRoot, workspace);
  assert.equal(status.configuration.enabled, false);
  assert.deepEqual(await hook("UserPromptSubmit"), {});
  const skill = skill => hook("PreToolUse", { tool_name: "Skill", tool_input: { skill } });
  assert.equal((await skill("personal-bot:project-maintenance")).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await skill("personal-bot:pbot"), {});
  assert.deepEqual(await skill("other:project-maintenance"), {});
  const expand = command_name => hook("UserPromptExpansion", { expansion_type: "slash_command", command_name });
  assert.equal((await expand("personal-bot:project-maintenance")).decision, "block");
  assert.deepEqual(await expand("personal-bot:pbot"), {});
  assert.deepEqual(await expand("other:project-maintenance"), {});
  assert.deepEqual(await hook("UserPromptExpansion", { expansion_type: "mcp_prompt", command_name: "personal-bot:project-maintenance" }), {});
  await assert.rejects(access(join(workspace, ".pbot")), { code: "ENOENT" });
  await assert.rejects(access(env.HOME), { code: "ENOENT" });
  await assert.rejects(access(env.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
});

test("init preserves user configuration and materials without interfering with native Claude subagents", async t => {
  const { workspace, env, run, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"));
  const stored = { enabled: false, custom: { keep: true } };
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify(stored));
  await writeFile(join(workspace, "AGENTS.md"), "User workspace guidance\n");
  await writeFile(join(workspace, "CLAUDE.md"), "Native user instructions\n");
  const result = await run(["init"]);
  assert.equal(result.configuration.enabled, true);
  assert.equal(result.workspaceRoot, workspace);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".pbot/config.json"), "utf8")), { ...stored, enabled: true });
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "User workspace guidance\n");
  assert.equal(await readFile(join(workspace, "CLAUDE.md"), "utf8"), "Native user instructions\n");
  for (const directory of ["areas", "projects", "knowledge", "providers", "scratch", "agents"]) await access(join(workspace, directory));
  const context = (await hook("UserPromptSubmit")).hookSpecificOutput;
  assert.equal(context.hookEventName, "UserPromptSubmit");
  const environment = JSON.parse(context.additionalContext.slice(context.additionalContext.lastIndexOf("\n\n") + 2));
  assert.deepEqual(environment, { host: "claude", workspaceRoot: workspace, resourceRoot });
  // Native Claude subagents (bearing agent_id) are left untouched.
  assert.deepEqual(await hook("UserPromptSubmit", { agent_id: "native-subagent-1" }), {});
  assert.deepEqual(await hook("PreToolUse", { tool_name: "Skill", tool_input: { skill: "personal-bot:project-maintenance" } }), {});
  assert.deepEqual(await hook("UserPromptExpansion", { expansion_type: "slash_command", command_name: "personal-bot:project-maintenance" }), {});
  assert.deepEqual(await readdir(join(workspace, ".pbot")), ["config.json"]);
  await assert.rejects(access(env.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
});

test("invalid configuration remains read-only and managed ACP targets skip duplicate plugin context", async t => {
  const { workspace, env, run, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"));
  const invalid = "{invalid";
  await writeFile(join(workspace, ".pbot/config.json"), invalid);
  assert.equal((await run(["status"])).configuration.enabled, false);
  await assert.rejects(run(["init"]));
  assert.equal(await readFile(join(workspace, ".pbot/config.json"), "utf8"), invalid);
  env.PBOT_SUBAGENT_RUN_ID = "managed-target";
  assert.deepEqual(await hook("UserPromptSubmit"), {});
});
