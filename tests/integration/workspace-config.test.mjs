import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { initializeWorkspaceConfig, workspaceConfigPath } from "../../dist/services/workspace/workspace-config.js";
import { resourceRoot } from "../../dist/common/paths.js";

function pbotSkills(options) {
  const directory = resolve(resourceRoot, "skills") + "/";
  return options.skills.filter(skill => resolve(skill.filePath).startsWith(directory));
}

test("Pi leaves an unconfigured workspace inactive with native tools and no Personal Bot model context", async t => {
  const { root, session, loader, errors } = await host(t, { workspaceEnabled: false });
  assert.deepEqual(loader.getSkills().skills.filter(skill => resolve(skill.filePath).startsWith(resolve(resourceRoot))), []);
  assert.deepEqual(pbotSkills(session._baseSystemPromptOptions), []);
  assert.equal(session.getAllTools().some(tool => tool.name.startsWith("pbot_")), false);
  assert.ok(session.agent.state.tools.some(tool => tool.name === "write"));
  await session._prepareRun({ messageType: "user", prompt: "Inspect local configuration" });
  assert.equal(Object.hasOwn(session._runSystemPromptOptions.sections, "pbot_environment"), false);
  assert.deepEqual(pbotSkills(session._runSystemPromptOptions), []);
  await session.prompt("/pbot status");
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(errors, []);
});

test("Pi init starts a missing workspace and discovers methods only after activation", async t => {
  const { root, session, loader, errors } = await host(t, { workspaceEnabled: false, noContextFiles: false });
  assert.deepEqual(pbotSkills(session._baseSystemPromptOptions), []);
  await session.prompt("/pbot init");
  assert.deepEqual(JSON.parse(await readFile(workspaceConfigPath(root), "utf8")), { enabled: true });
  assert.ok(session.getAllTools().some(tool => tool.name === "pbot_agent"));
  assert.ok(pbotSkills(session._baseSystemPromptOptions).length > 0);
  assert.ok(loader.getAgentsFiles().agentsFiles.some(file => file.path === join(root, "AGENTS.md")));
  assert.deepEqual(errors, []);
});

test("Pi reload applies workspace opt-in and opt-out and invalidates previously captured tools", async t => {
  const { root, session, errors } = await host(t, { workspaceEnabled: false });
  await initializeWorkspaceConfig(root);
  await session.reload();
  const previous = session.agent.state.tools.find(tool => tool.name === "pbot_agent");
  assert.ok(previous);
  await session._prepareRun({ messageType: "user", prompt: "Inspect enabled workspace" });
  assert.equal(JSON.parse(session._runSystemPromptOptions.sections.pbot_environment).workspaceRoot, root);
  assert.ok(pbotSkills(session._runSystemPromptOptions).length > 0);
  await writeFile(workspaceConfigPath(root), JSON.stringify({ enabled: false, future: { preserved: true } }));
  await session.reload();
  assert.equal(session.getCallableToolNames().some(name => name.startsWith("pbot_")), false);
  await assert.rejects(previous.execute("stale", { action: "list" }));
  await session._prepareRun({ messageType: "user", prompt: "Inspect disabled workspace" });
  assert.equal(Object.hasOwn(session._runSystemPromptOptions.sections, "pbot_environment"), false);
  assert.deepEqual(pbotSkills(session._runSystemPromptOptions), []);
  assert.deepEqual(await readdir(join(root, ".pbot")), ["config.json"]);
  assert.deepEqual(errors, []);
});

test("Pi keeps malformed workspace configuration disabled without changing native tools", async t => {
  const { root, session, errors } = await host(t, { prepare: async root => {
    await writeFile(workspaceConfigPath(root), '{"enabled":"true"}');
  } });
  assert.equal(session.getAllTools().some(tool => tool.name.startsWith("pbot_")), false);
  assert.ok(session.agent.state.tools.some(tool => tool.name === "read"));
  await session.prompt("/pbot status");
  assert.deepEqual(await readdir(root), [".pbot"]);
  assert.deepEqual(errors, []);
});
