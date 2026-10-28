import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { schema } from "../../dist/common/validation.js";
import { resourceRoot } from "../../dist/common/paths.js";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

test("Pi without Personal Bot configured does not activate from AGENTS.md or legacy files", async t => {
  const { root, session, loader, errors } = await host(t, { enabled: false, prepare: async root => {
    await writeFile(join(root, "AGENTS.md"), "User instructions");
    await mkdir(join(root, ".legacy"));
    await writeFile(join(root, ".legacy/workspace.json"), '{"format":"legacy/1","status":"ready"}');
  } });
  assert.deepEqual(session.getAllTools().filter(tool => tool.name.startsWith("pbot_")), []);
  assert.equal(loader.getSkills().skills.length, 0);
  const started = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, { cwd: root });
  assert.equal(Object.hasOwn(started.systemPromptOptions.sections, "pbot_environment"), false);
  assert.deepEqual(errors, []);
});

test("native autocomplete exposes current command contracts", async t => {
  const { root, session } = await host(t);
  const command = session.extensionRunner.getRegisteredCommands().find(command => command.name === "pbot");
  assert.ok(command);
  const autocomplete = new CombinedAutocompleteProvider([command], root);
  const suggest = text => autocomplete.getSuggestions([text], 0, text.length, { force: false });
  const all = await suggest("/pbot ");
  assert.equal(all.prefix, "");
  assert.deepEqual(all.items.map(item => item.value), ["init", "status", "agents", "teams", "python"]);
  const filtered = await suggest("/pbot st");
  assert.deepEqual(filtered.items.map(item => item.value), ["status"]);
  const completed = autocomplete.applyCompletion(["/pbot st"], 0, 8, filtered.items[0], filtered.prefix);
  assert.equal(completed.lines[0].trimEnd(), "/pbot status");
  for (const text of ["/pbot unknown", "/pbot upgrade", "/pbot python /", "/pbot init "]) {
    assert.equal(await suggest(text), null);
  }
});

for (const legacy of [undefined, '{"format":"legacy/1","status":"pending"}', "invalid historical JSON"]) {
  test("loading Personal Bot enables tools and skills without reading or creating workspace state: " + (legacy ?? "empty"), async t => {
    const { root, loader, session, errors } = await host(t, { prepare: async root => {
      if (legacy === undefined) return;
      await mkdir(join(root, ".legacy"));
      await writeFile(join(root, ".legacy/workspace.json"), legacy);
    } });
    const started = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, { cwd: root });
    assert.doesNotThrow(() => buildSystemPrompt(started.systemPromptOptions));
    const environment = JSON.parse(started.systemPromptOptions.sections.pbot_environment);
    assert.equal(environment.workspaceRoot, root);
    assert.equal(environment.resourceRoot, resourceRoot);
    assert.equal(environment.python.state, "error");
    assert.deepEqual(errors, []);
    assert.deepEqual(session.getAllTools().map(t => t.name).filter(n => n.startsWith("pbot_")).sort(), ["pbot_agent", "pbot_team", "pbot_team_message"]);
    assert.ok(loader.getSkills().skills.length > 0);
    assert.deepEqual(await readdir(root), legacy === undefined ? [] : [".legacy"]);
    if (legacy !== undefined) assert.equal(await readFile(join(root, ".legacy/workspace.json"), "utf8"), legacy);
    await session.prompt("/pbot init");
    assert.deepEqual(errors, []);
    await writeFile(join(root, "AGENTS.md"), "User instructions");
    await session.prompt("/pbot init");
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "User instructions");
    assert.deepEqual(session.getAllTools().map(t => t.name).filter(n => n.startsWith("pbot_")).sort(), ["pbot_agent", "pbot_team", "pbot_team_message"]);
  });
}

async function runScript(session, id, code, signal) {
  // Restore a local session call record. No model produces or executes this fixture.
  const model = session.model;
  assert.ok(model);
  session.sessionManager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }], stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return session.agent.state.tools.find(tool => tool.name === "codemode").execute(id, { code }, signal);
}
function scriptValue(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.slice(1).map(part => part.text).join(""));
}


test("real codemode discovers Personal Bot and uses native CLI without initialization", async t => {
  const { session } = await host(t);
  const result = await runScript(session, "native-tools", `
    const names = ALL_TOOLS.filter(tool => tool.name.startsWith("pbot_")).map(tool => tool.name).sort();
    const namespace = await describeNamespace("pbot");
    const output = await tools.bash({ command: "printf '%s' 42" });
    const agents = await tools.pbot_agent({ action: "list" });
    return { names, namespace: namespace.name, agents, output };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.names, ["pbot_agent", "pbot_team", "pbot_team_message"]);
  assert.equal(data.namespace, "pbot");
  assert.deepEqual(data.agents, { agents: [] });
  assert.ok(result.details.calls.every(call => call.status === "ok"));
});

test("native write works in the workspace and requires confirmation outside it", async t => {
  const { root, session } = await host(t);
  const result = await runScript(session, "file-edits", `
    await tools.write({ path: "projects/report.txt", content: "Research" });
    const outcome = await Promise.allSettled([tools.write({ path: "../outside/report.txt", content: "Research" })]);
    return { status: outcome[0].status };
  `);
  assert.equal(scriptValue(result).status, "rejected");
  assert.equal(await readFile(join(root, "projects/report.txt"), "utf8"), "Research");
  await assert.rejects(readdir(join(root, "../outside")), { code: "ENOENT" });
});

test("remaining tool declarations and structured outputs match their contracts", async t => {
  const { session } = await host(t);
  const tools = session.agent.state.tools.filter(t => t.name.startsWith("pbot_"));
  for (const tool of JSON.parse(JSON.stringify(convertResponsesTools(tools)))) {
    assert.equal(tool.parameters.type, "object", tool.name);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(tool.parameters[keyword], undefined);
  }
  const agent = tools.find(t => t.name === "pbot_agent");
  const output = await agent.execute("list", { action: "list" });
  assert.ok(schema(agent.outputSchema)(output.structuredContent));
  assert.deepEqual(output.details, output.structuredContent);
  await assert.rejects(agent.execute("removed", { action: "wait", agentId: "x" }));
});

test("workspace shutdown invalidates previously acquired tools", async t => {
  const { session } = await host(t);
  const agent = session.agent.state.tools.find(t => t.name === "pbot_agent");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await assert.rejects(agent.execute("stale", { action: "list" }));
  assert.ok(!session.getCallableToolNames().includes("pbot_agent"));
});
