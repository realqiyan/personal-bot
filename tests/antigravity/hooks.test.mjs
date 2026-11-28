import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pluginHook, pluginCommand } from "../../dist/extension/hosts/plugin-runtime.js";
import { pluginHosts, registerPluginHost } from "../../dist/integrations/hosts/plugin-registry.js";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";
import { runWorkspaceSummaries } from "../../dist/services/history/summary-runner.js";
import { AgentFiles } from "../../dist/storage/agent-files.js";
import { dshAcpHarness } from "../../dist/integrations/acp/harnesses/dsh.js";
import { piAcpHarness } from "../../dist/integrations/acp/harnesses/pi.js";

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

test("installed Antigravity bundle loads its Pi and dsh members through each native host", async t => {
  const { root, pluginDir, workspace, env, run } = await fixture(t);
  const { version } = await run(["init"]);
  await assert.rejects(access(join(pluginDir, "node_modules")), { code: "ENOENT" });
  const id = randomUUID(), generation = randomUUID();
  const files = new AgentFiles(join(root, "control"));
  const pi = resolve("node_modules/.bin/pi");
  files.create({ agentId: id, release: version, workspace, cwd: workspace, parentSessionId: "parent", parentLeaf: null,
    createdAt: 1, options: {} }, { generation, name: "installed-member", sequence: 0, stop: false, startedAt: 1 },
  { host: "acp", backend: "pi", command: pi, args: [], sessionId: null });
  const directory = files.directory(id);
  const context = { directory, packageRoot: pluginDir, env, reference: { command: pi, args: [] } };
  const launch = piAcpHarness.prepareLaunch(context);
  const rpc = exec(process.execPath, [launch.env.PI_ACP_PI_COMMAND, "--mode", "rpc", "--no-session"], {
    cwd: workspace, env: { ...env, PBOT_ACP_PI_COMMAND: pi, PBOT_SUBAGENT_RUN_ID: id, PBOT_SUBAGENT_DIR: directory,
      PBOT_SUBAGENT_GENERATION: generation, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "pi") }, timeout: 20_000,
  });
  rpc.child.stdin.end('{"type":"get_state","id":"state"}\n{"type":"get_commands","id":"commands"}\n');
  const { stdout, stderr } = await rpc;
  const records = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.find(record => record.id === "state")?.data?.sessionName, "installed-member", stderr);
  assert.ok(records.find(record => record.id === "commands")?.data?.commands.some(command =>
    command.name === "skill:provider-connections"), stderr);

  const dsh = await dshAcpHarness.prepareLaunch({ ...context, reference: { command: resolve("node_modules/.bin/dsh"), args: ["--profile", "acp"] } });
  const schema = await exec(dsh.command.command, [...dsh.command.args, "--dump-config-schema"], {
    cwd: workspace, env: dsh.env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
  });
  const config = JSON.parse(schema.stdout)["x-cordis"];
  assert.equal(config.complete, true);
  assert.equal(config.entries.find(entry => entry.id === "pbot-acp-member")?.status, "absent"); // Loaded without a Config export.
});

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
    summary: { backend: "pi", concurrency: 3 },
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
  const previousHome = process.env.HOME;
  process.env.HOME = join(workspace, "test-home");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
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

test("Antigravity SessionStart injects a summary reminder when raw history is 7+ days old and unsummarized", async t => {
  const { workspace, hook } = await fixture(t);
  await mkdir(join(workspace, ".pbot"), { recursive: true });
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true }));

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  recordHistoryCapture(workspace, "antigravity", { kind: "input", sessionId: "agy-old-1", text: "十天前的对话", timestamp: tenDaysAgo });
  recordHistoryCapture(workspace, "antigravity", { kind: "answer", sessionId: "agy-old-1", assistantText: "十天前的答复", completed: true, timestamp: tenDaysAgo });

  const started = await hook("SessionStart");
  const message = started.injectSteps[0].systemMessage.systemMessage;
  assert.ok(message.includes("/pbot history summary"));
  const environment = JSON.parse(message.slice(message.lastIndexOf("\n\n") + 2));
  assert.equal(environment.host, "antigravity");

  await runWorkspaceSummaries({ root: workspace, summarizer: async () => "已完成摘要。" });
  const afterSummary = await hook("SessionStart");
  const cleanMessage = afterSummary.injectSteps[0].systemMessage.systemMessage;
  assert.equal(cleanMessage.includes("/pbot history summary"), false);
});
