import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HistoryFiles } from "../../dist/storage/history-files.js";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";
import { checkHistoryMigrationNotice } from "../../dist/services/history/history-migrate.js";
import { checkHistorySummaryReminder } from "../../dist/services/history/summary-runner.js";

const bundles = {
  codex: "lib/codex-marketplace/plugins/personal-bot",
  qoder: "lib/qoder-plugin",
};
const hookEvents = ["SessionStart", "Stop", "UserPromptSubmit"];
for (const [host, bundle] of Object.entries(bundles)) {
  test(host + " installed hooks honor root opt-in, feature flags and main-session history", async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pbot host ")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await symlink(resolve("bin/pbot.mjs"), join(root, "pbot"));
    const env = { HOME: root, PATH: root + ":" + process.env.PATH };
    const hooks = JSON.parse(await readFile(join(bundle, "hooks/hooks.json"), "utf8")).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), hookEvents);
    const session_id = "session-1";
    const run = (hook_event_name, fields = {}) => {
      const input = JSON.stringify({ cwd: workspace, hook_event_name, session_id, ...fields });
      const output = execFileSync("sh", ["-c", hooks[hook_event_name][0].hooks[0].command], {
        cwd: root, env, input, encoding: "utf8",
      });
      return JSON.parse(output);
    };
    // An enabled parent must not activate a nested workspace.
    execFileSync("pbot", ["plugin", host, "init"], { cwd: root, env });
    assert.deepEqual(run("UserPromptSubmit", { prompt: "inactive" }), {});
    const config = join(workspace, ".pbot/config.json");
    execFileSync("pbot", ["plugin", host, "init"], { cwd: workspace, env });
    if (host === "qoder") env.QODER_PROJECT_DIR = workspace;
    const hookCwd = host === "qoder" ? root : workspace;
    assert.deepEqual(run("SessionStart", { cwd: hookCwd }), {});
    const context = run("UserPromptSubmit", { cwd: hookCwd, prompt: "input" }).hookSpecificOutput;
    assert.equal(context.hookEventName, "UserPromptSubmit");
    const environment = JSON.parse(context.additionalContext.split("\n\n").at(-1));
    assert.equal(environment.host, host);
    assert.equal(environment.workspaceRoot, workspace);
    const skillPath = join(environment.resourceRoot, "skills/project-maintenance/SKILL.md");
    assert.ok(context.additionalContext.includes(skillPath));
    assert.deepEqual(run("Stop", { last_assistant_message: "answer" }), {});
    assert.deepEqual(run("UserPromptSubmit", { agent_id: "native", prompt: "ignore" }), {});
    await writeFile(config, JSON.stringify({ enabled: true, history: { layout: "flat" } }));
    recordHistoryCapture(workspace, host, { kind: "input", sessionId: "flat", text: "legacy" });
    await writeFile(config, JSON.stringify({ enabled: true }));
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    recordHistoryCapture(workspace, host, { kind: "input", sessionId: "old", text: "pending", timestamp: old });
    const notices = run("SessionStart", { cwd: hookCwd, source: "startup" }).hookSpecificOutput;
    assert.equal(notices.hookEventName, "SessionStart");
    const reminder = checkHistorySummaryReminder(workspace).message;
    const migration = checkHistoryMigrationNotice(workspace);
    assert.ok(notices.additionalContext.includes(reminder));
    assert.ok(notices.additionalContext.includes(migration));
    assert.ok(!notices.additionalContext.includes(skillPath));
    for (const source of ["resume", "compact"]) assert.deepEqual(run("SessionStart", { cwd: hookCwd, source }), {});
    const next = run("UserPromptSubmit", { cwd: hookCwd, session_id: "next", prompt: "next" }).hookSpecificOutput;
    assert.ok(!next.additionalContext.includes(reminder));
    assert.ok(!next.additionalContext.includes(migration));
    env.PBOT_SUBAGENT_RUN_ID = "managed";
    assert.deepEqual(run("SessionStart"), {});
    assert.deepEqual(run("UserPromptSubmit", { prompt: "ignore" }), {});
    delete env.PBOT_SUBAGENT_RUN_ID;
    await writeFile(config, JSON.stringify({ enabled: true, features: { skills: false, history: false } }));
    assert.deepEqual(run("SessionStart"), {});
    assert.ok(!run("UserPromptSubmit", { prompt: "ignore" }).hookSpecificOutput.additionalContext.includes(skillPath));
    await writeFile(config, JSON.stringify({ enabled: true, features: { skills: false, prompts: false, history: false, mcp: false } }));
    assert.deepEqual(run("UserPromptSubmit", { prompt: "ignore" }), {});
    const raw = new HistoryFiles(join(workspace, ".pbot/history"), host).listRaw().find(item => item.sessionId === session_id);
    assert.equal(raw.host, host);
    assert.equal(raw.sessionId, session_id);
    assert.equal(raw.exchanges.length, 1);
    assert.equal(raw.exchanges[0].completed, true);
    assert.match(raw.exchanges[0].text, /input[\s\S]+answer/);

    const { pbot } = JSON.parse(await readFile(join(bundle, ".mcp.json"), "utf8")).mcpServers;
    assert.equal(pbot.env.PBOT_HOST, host);
    env.CLAUDE_PROJECT_DIR = root;
    const mcp = (method, params) => JSON.parse(execFileSync(pbot.command, pbot.args, {
      input: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }) + "\n",
      cwd: host === "qoder" ? root : workspace, env: { ...env, ...pbot.env }, encoding: "utf8",
    })).result;
    const tools = mcp("tools/list", {}).tools.map(tool => tool.name);
    assert.deepEqual(tools.sort(), ["worker_close", "worker_create", "worker_discover", "worker_output", "worker_request", "worker_response"].sort());
    assert.equal(mcp("tools/call", { name: "history_search", arguments: {} }).isError, true);
  });
}

test("Codex history correlates interrupted, attachment-only and steered turns across hook processes", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "pbot codex turns ")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cli = resolve("bin/pbot.mjs");
  const options = { cwd: workspace, env: { HOME: workspace, PATH: process.env.PATH } };
  execFileSync(cli, ["plugin", "codex", "init"], options);
  const hook = (hook_event_name, turn_id, fields) => execFileSync(cli, ["plugin", "codex", "hook"], {
    ...options, input: JSON.stringify({ cwd: workspace, session_id: "conversation", hook_event_name, turn_id, ...fields }),
  });
  hook("UserPromptSubmit", "first", { prompt: "interrupted" });
  hook("UserPromptSubmit", "image", { prompt: "" });
  hook("UserPromptSubmit", "steered", { prompt: "question" });
  hook("UserPromptSubmit", "steered", { prompt: "clarification" });
  hook("Stop", "image", { last_assistant_message: "image answer" });
  hook("Stop", "steered", { last_assistant_message: "combined answer" });
  const files = new HistoryFiles(join(workspace, ".pbot/history"), "codex");
  const [raw] = files.listRaw();
  assert.deepEqual(raw.exchanges.map(item => item.completed), [false, true, true]);
  assert.ok(!raw.exchanges[0].text.includes("answer"));
  assert.ok(raw.exchanges[1].text.includes("image answer"));
  assert.match(raw.exchanges[2].text, /question[\s\S]+clarification[\s\S]+combined answer/);
  hook("Stop", "image", { last_assistant_message: "image answer" });
  assert.deepEqual(files.listRaw(), [raw]);
});

for (const [host, executable] of [["codex", "codex"], ["qoder", "qodercli"]]) {
  test(host + " native installer discovers the generated plugin", async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pbot native plugin ")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "codex") };
    const run = args => execFileSync(executable, args, { env, cwd: root, encoding: "utf8", timeout: 30000 });
    if (host === "codex") await mkdir(env.CODEX_HOME);
    try { run(["--version"]); }
    catch (error) {
      if (error.code === "ENOENT") return t.skip(executable + " is not installed");
      throw error;
    }
    if (host === "codex") {
      run(["plugin", "marketplace", "add", resolve("lib/codex-marketplace")]);
      const installed = JSON.parse(run(["plugin", "add", "personal-bot@pbot-local", "--json"]));
      assert.equal(installed.pluginId, "personal-bot@pbot-local");
      const server = JSON.parse(run(["mcp", "list", "--json"])).find(item => item.name === "pbot");
      assert.equal(server.enabled, true);
      assert.equal(server.transport.env.PBOT_HOST, host);
      const prompt = run(["debug", "prompt-input", "probe"]);
      assert.ok(!prompt.includes("personal-bot:pbot:"));
      const forwarded = JSON.parse(run(["-c", 'mcp_servers.pbot.command="pbot"', "-c", 'mcp_servers.pbot.args=["mcp"]',
        "-c", 'mcp_servers.pbot.env.PBOT_HOST="codex"', "-c", 'mcp_servers.pbot.env_vars=["PBOT_TEST_LABEL"]',
        "mcp", "list", "--json"])).find(item => item.name === "pbot");
      assert.deepEqual(forwarded.transport.env_vars, ["PBOT_TEST_LABEL"]);
    } else {
      const args = ["--config-dir", join(root, "qoder"), "plugin"];
      const directory = resolve(bundles.qoder);
      const { report } = JSON.parse(run([...args, "validate", "--strict", "--json", directory]));
      assert.equal(report.valid, true);
      assert.deepEqual(report.resources.agents, []);
      assert.equal(JSON.parse(run([...args, "install", directory, "--json"])).ok, true);
      const plugin = JSON.parse(run([...args, "list", "--json"])).find(item => item.name === "personal-bot");
      assert.equal(plugin.enabled, true);
      assert.deepEqual(plugin.resources.hooks.map(item => item.event).sort(), hookEvents);
      assert.ok(plugin.resources.mcpServers.some(item => item.name === "pbot" && item.type === "stdio"));
    }
  });
}
