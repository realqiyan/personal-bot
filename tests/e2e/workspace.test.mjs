import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rpcWorkspace } from "../helpers/pi-rpc.mjs";
import { packageVersion } from "../../dist/common/version.js";

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

test("E2E: startup reports a damaged Python environment, preserves history and leaves native Bash available", { timeout: 60_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  let pi = await workspace.start();
  const resources = await pi.inspect();
  assert.deepEqual(resources.tools.filter(name => name.startsWith("pbot_")).sort(), ["pbot_agent", "pbot_team", "pbot_team_message"]);
  assert.ok(resources.skills.length > 0);
  assert.deepEqual(await readdir(workspace.root), []);
  const context = await pi.driver("context");
  assert.equal(context.workspace, true);
  assert.equal(context.environment.workspaceRoot, workspace.root);
  assert.equal(context.environment.python.state, "error");
  const documents = "# User workspace\n\nKeep these research notes across preparation and restart.\n";
  await writeFile(join(workspace.root, "AGENTS.md"), documents);
  await pi.command("/pbot init");
  await pi.command("/pbot init");
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  await assert.rejects(readdir(join(workspace.root, ".pbot")), { code: "ENOENT" });

  await assert.rejects(pi.execute("pbot_python", { code: "print(42)" }));
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

  assert.ok(pi.records.some(record => record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "warning"));
  await pi.command("/pbot status");
  const status = pi.records.findLast(record => record.type === "extension_ui_request" && record.method === "notify");
  assert.deepEqual(JSON.parse(status.message), {
    workspaceRoot: workspace.root, release: packageVersion, python: context.environment.python,
  });
  await pi.command("/pbot python setup");
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.deepEqual(await readdir(join(workspace.temp, "home/data/pbot/python/.venv")), []);
  // The removed interpreter-binding command cannot alter existing settings.
  await pi.command("/pbot python /usr/bin/python3");
  const requests = pi.records.filter(record => record.type === "extension_ui_request" && record.method === "confirm").length;
  await pi.command("/pbot python setup /usr/bin/python3");
  assert.equal(pi.records.filter(record => record.type === "extension_ui_request" && record.method === "confirm").length, requests);
  assert.equal(await readFile(settingsPath, "utf8"), settings);

  const project = join(workspace.root, "projects/local-research");
  await mkdir(project, { recursive: true });
  const code = "import json,sys\nfrom pathlib import Path\nfrom calculation import total\nvalues=json.loads(Path('inputs.json').read_text())\nresult={'total':total(values), 'args':sys.argv[1:]}\nPath('output.json').write_text(json.dumps(result))\nprint(json.dumps(result))";
  await writeFile(join(project, "analyze.py"), code);
  await writeFile(join(project, "calculation.py"), "def total(values): return sum(values)\n");
  await writeFile(join(project, "inputs.json"), JSON.stringify([7, 11, 24]));
  const result = await pi.execute("bash", {
    command: "cd " + JSON.stringify(project) + " && python3 analyze.py --window 20",
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const output = { total: 42, args: ["--window", "20"] };
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === "text").text), output);
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(project, "analyze.py"), "utf8"), code);
  assert.deepEqual(await readdir(join(workspace.root, "scratch/runs")), ["previous"]);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });

  pi = await workspace.start();
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  assert.ok(!(await pi.inspect()).tools.includes("pbot_python"));
  assert.deepEqual(await readJson(join(project, "output.json")), output);
  assert.equal(await readFile(join(history, "main.py"), "utf8"), historicalCode);
  assert.equal(await readFile(join(history, "output.json"), "utf8"), historicalOutput);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.equal(await readFile(join(workspace.root, "AGENTS.md"), "utf8"), documents);
  await assert.rejects(readdir(join(workspace.root, ".legacy/calls")), { code: "ENOENT" });
});
