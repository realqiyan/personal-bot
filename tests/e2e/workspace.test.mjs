import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rpcWorkspace } from "../helpers/pi-rpc.mjs";
import { packageVersion } from "../../dist/common/version.js";
import { resourceRoot } from "../../dist/common/paths.js";

const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test("E2E: an unconfigured workspace stays inactive until native init starts it", { timeout: 60000 }, async t => {
  const workspace = await rpcWorkspace(t, { workspaceEnabled: false });
  const original = "User-owned workspace instructions\n";
  await writeFile(join(workspace.root, "AGENTS.md"), original);
  const pi = await workspace.start();
  const before = await pi.inspect();
  assert.equal(before.tools.some(name => name.startsWith("pbot_")), false);
  assert.deepEqual(before.skills, []);
  await pi.command("/pbot status");
  const status = () => JSON.parse(pi.records.findLast(record => record.type === "extension_ui_request" && record.method === "notify").message);
  assert.equal(status().state, "disabled");
  assert.equal(status().nextStep, "/pbot init");
  await pi.command("/pbot init");
  await pi.command("/pbot status");
  assert.equal(status().state, "running");
  assert.equal(status().enabled, true);
  const after = await pi.inspect();
  assert.ok(after.tools.includes("pbot_history"));
  assert.ok(after.skills.includes("provider-connections"));
  assert.deepEqual(await readJson(join(workspace.root, ".pbot/config.json")), { enabled: true });
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), original);
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  assert.equal(pi.records.some(record => record.type === "agent_start"), false);
});

test("E2E: startup preserves history and leaves native Bash available", { timeout: 60_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  let pi = await workspace.start();
  const resources = await pi.inspect();
  assert.deepEqual(resources.tools.filter(name => name.startsWith("pbot_")).sort(), ["pbot_history"]);
  assert.ok(resources.skills.length > 0);
  assert.deepEqual(await readdir(workspace.root), [".pbot"]);
  const context = await pi.driver("context");
  assert.equal(context.workspace, true);
  assert.deepEqual(context.environment, { host: "pi", workspaceRoot: workspace.root, resourceRoot });
  const documents = "# User workspace\n\nKeep these research notes across preparation and restart.\n";
  await writeFile(join(workspace.root, "AGENTS.md"), documents);
  await pi.command("/pbot init");
  await pi.command("/pbot init");
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  assert.deepEqual(await readdir(join(workspace.root, ".pbot")), ["config.json"]);

  await assert.rejects(readdir(join(workspace.root, "scratch/runs")), { code: "ENOENT" });
  await mkdir(join(workspace.root, ".legacy"));
  const settingsPath = join(workspace.root, ".legacy/settings.json");
  const settings = JSON.stringify({ python: "/previous/environment/bin/python" });
  await writeFile(settingsPath, settings);
  const history = join(workspace.root, "scratch/runs/previous");
  await mkdir(history, { recursive: true });
  const historicalCode = "print(42)\n", historicalOutput = '{"stdout":"42\\n"}\n';
  await writeFile(join(history, "main.py"), historicalCode);
  await writeFile(join(history, "output.json"), historicalOutput);

  await pi.command("/pbot status");
  const status = pi.records.findLast(record => record.type === "extension_ui_request" && record.method === "notify");
  const details = JSON.parse(status.message);
  assert.equal(details.workspaceRoot, workspace.root); assert.equal(details.release, packageVersion);
  assert.equal(details.state, "running");
  assert.equal(details.enabled, true);

  const project = join(workspace.root, "projects/local-research");
  await mkdir(project, { recursive: true });
  const code = "import { readFile, writeFile } from 'node:fs/promises';\nimport { total } from './calculation.mjs';\nconst values = JSON.parse(await readFile('inputs.json', 'utf8'));\nconst result = { total: total(values), args: process.argv.slice(2) };\nawait writeFile('output.json', JSON.stringify(result));\nconsole.log(JSON.stringify(result));";
  await writeFile(join(project, "analyze.mjs"), code);
  await writeFile(join(project, "calculation.mjs"), "export const total = values => values.reduce((sum, value) => sum + value, 0);\n");
  await writeFile(join(project, "inputs.json"), JSON.stringify([7, 11, 24]));
  const result = await pi.execute("bash", {
    command: "cd " + shellQuote(project) + " && " + shellQuote(process.execPath) + " analyze.mjs --window 20",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const output = { total: 42, args: ["--window", "20"] };
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === "text").text), output);
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(project, "analyze.mjs"), "utf8"), code);
  assert.deepEqual(await readdir(join(workspace.root, "scratch/runs")), ["previous"]);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  pi = await workspace.start();
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(history, "main.py"), "utf8"), historicalCode);
  assert.equal(await readFile(join(history, "output.json"), "utf8"), historicalOutput);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  await assert.rejects(readdir(join(workspace.root, ".legacy/calls")), { code: "ENOENT" });
});
