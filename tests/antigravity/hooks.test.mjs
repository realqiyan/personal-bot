import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const builtBundle = resolve("lib/antigravity-plugin");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-antigravity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginDir = join(root, "installed-plugin");
  const workspace = join(root, "workspace");
  const nested = join(workspace, "nested");
  await Promise.all([
    cp(builtBundle, pluginDir, { recursive: true }),
    mkdir(nested, { recursive: true }),
  ]);
  const entry = join(pluginDir, "lib/plugin.js");
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), PLUGIN_ROOT: pluginDir };
  const run = async (args, { cwd = workspace, input, extraEnv = {} } = {}) => {
    const child = exec(process.execPath, [entry, "antigravity", ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      timeout: 30_000,
    });
    child.child.stdin.end(input ? JSON.stringify(input) : undefined);
    const output = await child;
    return JSON.parse(output.stdout);
  };
  const hook = (hookEventName, values = {}, extraEnv = {}) =>
    run(["hook"], { cwd: pluginDir, input: { hookEventName, workspacePaths: [workspace], cwd: nested, ...values }, extraEnv });
  return { root, pluginDir, workspace, nested, env, run, hook };
}

test("disabled Antigravity hooks gate bundled skills and leave workspace untouched", async t => {
  const { root, pluginDir, workspace, run, hook } = await fixture(t);
  await mkdir(join(root, ".pbot"));
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true }));
  const status = await run(["status"]);
  assert.equal(status.workspaceRoot, workspace);
  assert.equal(status.configuration.enabled, false);
  assert.equal(status.resourceRoot, join(pluginDir, "resources") + "/");
  assert.deepEqual(await hook("SessionStart"), {});
  const skillRead = path => hook("PreToolUse", { toolCall: { id: "t1", name: "read_file", args: { Path: path } } });
  assert.equal((await skillRead(join(pluginDir, "skills/project-maintenance/SKILL.md"))).decision, "deny");
  assert.equal((await skillRead(join(pluginDir, "skills/provider-connections/SKILL.md"))).decision, "deny");
  assert.deepEqual(await skillRead(join(pluginDir, "skills/pbot/SKILL.md")), { decision: "allow" });
  assert.deepEqual(await skillRead(join(workspace, "README.md")), { decision: "allow" });
  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t2", name: "invoke_subagent", args: { TypeName: "general-purpose", Role: "Helper", Prompt: "Check status" } },
  }), { decision: "allow" });
  await assert.rejects(access(join(workspace, ".pbot")), { code: "ENOENT" });
});

test("enabled Antigravity workspace injects SessionStart context and subagent workspace supplement", async t => {
  const { pluginDir, workspace, run, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"));
  const stored = { enabled: false, custom: { keep: true } };
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify(stored));
  await writeFile(join(workspace, "AGENTS.md"), "UNIQUE_NATIVE_AGENTS_MARKER\n");
  const initialized = await run(["init"]);
  assert.equal(initialized.configuration.enabled, true);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".pbot/config.json"), "utf8")), { ...stored, enabled: true });
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "UNIQUE_NATIVE_AGENTS_MARKER\n");
  for (const directory of ["areas", "projects", "knowledge", "providers", "scratch", "agents"]) {
    await access(join(workspace, directory));
  }
  await writeFile(join(workspace, "agents/general-purpose.md"), "LOCAL_EXPERT_RULE\n");

  const started = await hook("SessionStart");
  assert.equal(Array.isArray(started.injectSteps), true);
  const message = started.injectSteps[0].systemMessage.systemMessage;
  assert.equal(message.includes("UNIQUE_NATIVE_AGENTS_MARKER"), false);
  const environment = JSON.parse(message.slice(message.lastIndexOf("\n\n") + 2));
  assert.deepEqual(environment, { host: "antigravity", workspaceRoot: workspace, resourceRoot: join(pluginDir, "resources") + "/" });

  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t3", name: "read_file", args: { Path: join(pluginDir, "skills/project-maintenance/SKILL.md") } },
  }), { decision: "allow" });

  const subagent = await hook("PreToolUse", {
    toolCall: { id: "t4", name: "invoke_subagent", args: { TypeName: "general-purpose", Role: "Analyst", Prompt: "Run analysis" } },
  });
  assert.equal(subagent.decision, "allow");
  assert.ok(subagent.overwrite.Prompt.includes("LOCAL_EXPERT_RULE"));
  assert.ok(subagent.overwrite.Prompt.includes("Run analysis"));
  assert.ok(subagent.overwrite.Prompt.includes(workspace));

  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t5", name: "invoke_subagent", args: { TypeName: "research", Role: "Explorer", Prompt: "Scan repo" } },
  }), { decision: "allow" });
  assert.deepEqual(await readdir(join(workspace, ".pbot")), ["config.json"]);
});

test("invalid config stays read-only and managed subagents pass through cleanly", async t => {
  const { workspace, run, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"));
  const invalid = "{invalid";
  await writeFile(join(workspace, ".pbot/config.json"), invalid);
  assert.equal((await run(["status"])).configuration.enabled, false);
  await assert.rejects(run(["init"]));
  assert.equal(await readFile(join(workspace, ".pbot/config.json"), "utf8"), invalid);
  assert.deepEqual(await hook("SessionStart", {}, { PBOT_SUBAGENT_RUN_ID: "managed" }), {});
  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t6", name: "read_file", args: { Path: "/tmp/file" } },
  }, { PBOT_SUBAGENT_RUN_ID: "managed" }), { decision: "allow" });
});
