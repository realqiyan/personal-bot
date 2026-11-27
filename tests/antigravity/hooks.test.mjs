import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pluginHook, pluginCommand } from "../../dist/extension/hosts/plugin-runtime.js";
import { pluginHosts, registerPluginHost } from "../../dist/integrations/hosts/plugin-registry.js";

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
  // Host-native subagent calls are never intercepted or modified.
  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t2", name: "invoke_subagent", args: { TypeName: "research", Role: "Explorer", Prompt: "Check status" } },
  }), { decision: "allow" });
  await assert.rejects(access(join(workspace, ".pbot")), { code: "ENOENT" });
});

test("enabled Antigravity workspace injects SessionStart context and never interferes with native subagents", async t => {
  const { pluginDir, workspace, run, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"));
  const stored = { enabled: false, custom: { keep: true } };
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify(stored));
  await writeFile(join(workspace, "AGENTS.md"), "UNIQUE_NATIVE_AGENTS_MARKER\n");
  const initialized = await run(["init"]);
  assert.equal(initialized.configuration.enabled, true);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".pbot/config.json"), "utf8")), {
    ...stored,
    enabled: true,
    features: { prompts: true, skills: true, mcp: true, history: true },
  });
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "UNIQUE_NATIVE_AGENTS_MARKER\n");
  for (const directory of ["areas", "projects", "knowledge", "providers", "scratch", "agents"]) {
    await access(join(workspace, directory));
  }
  await assert.rejects(access(join(pluginDir, "agents")), { code: "ENOENT" });

  const started = await hook("SessionStart");
  assert.equal(Array.isArray(started.injectSteps), true);
  const message = started.injectSteps[0].systemMessage.systemMessage;
  assert.equal(message.includes("UNIQUE_NATIVE_AGENTS_MARKER"), false);
  const environment = JSON.parse(message.slice(message.lastIndexOf("\n\n") + 2));
  assert.deepEqual(environment, { host: "antigravity", workspaceRoot: workspace, resourceRoot: join(pluginDir, "resources") + "/" });

  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t3", name: "read_file", args: { Path: join(pluginDir, "skills/project-maintenance/SKILL.md") } },
  }), { decision: "allow" });

  // Native invoke_subagent passes through without any overwrite.
  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t4", name: "invoke_subagent", args: { TypeName: "self", Role: "Analyst", Prompt: "Run analysis" } },
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

test("plugin host registry supports registering new hosts without modifying runtime code", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "pbot-custom-host-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const customAdapter = {
    host: "custom-ide",
    nativeRootAgents: true,
    coordinatorPrompt: "plugin-coordinator.md",
    initCommandHint: "/pbot init",
    usage: "custom-ide init|status",
    async resolveRoot(cwd) { return realpath(cwd); },
    parseEvent(payload) {
      if (payload?.event === "start") return { kind: "inject-context", role: "coordinator", cwd: payload.cwd, raw: payload };
      return { kind: "ignore" };
    },
    formatPass() { return { ok: true }; },
    formatContext(_event, context) { return { injected: context.text, host: context.environment.host }; },
    formatDeny(_event, reason) { return { denied: reason }; },
  };
  registerPluginHost(customAdapter);
  t.after(() => pluginHosts.unregister("custom-ide"));

  assert.equal(pluginHosts.require("custom-ide"), customAdapter);
  assert.deepEqual(await pluginHook(customAdapter, { event: "start", cwd: workspace }), { ok: true });
  const initResult = await pluginCommand(customAdapter, ["init"], workspace);
  assert.equal(initResult.configuration.enabled, true);
  const started = await pluginHook(customAdapter, { event: "start", cwd: workspace });
  assert.equal(started.host, "custom-ide");
  assert.equal(typeof started.injected, "string");
});

test("Antigravity skips duplicate .agents/skills injection and honors optional feature toggles", async t => {
  const { pluginDir, workspace, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"), { recursive: true });
  await mkdir(join(workspace, ".agents/skills/native-skill"), { recursive: true });
  await writeFile(join(workspace, ".agents/skills/native-skill/SKILL.md"), "---\nname: native-skill\ndescription: Native Antigravity skill\n---\nBody\n");
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true }));

  const started = await hook("SessionStart");
  const message = started.injectSteps[0].systemMessage.systemMessage;
  assert.equal(message.includes("native-skill"), false);

  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true, features: { prompts: false, skills: false, mcp: false } }));
  assert.deepEqual(await hook("SessionStart"), {});
  assert.equal((await hook("PreToolUse", {
    toolCall: { id: "t-skill", name: "read_file", args: { Path: join(pluginDir, "skills/project-maintenance/SKILL.md") } },
  })).decision, "deny");
  assert.deepEqual(await hook("PreToolUse", {
    toolCall: { id: "t-pbot", name: "read_file", args: { Path: join(pluginDir, "skills/pbot/SKILL.md") } },
  }), { decision: "allow" });
});
