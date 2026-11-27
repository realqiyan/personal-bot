import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { schema } from "../../dist/common/schema.js";
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
  assert.deepEqual(all.items.map(item => item.value), ["init", "status", "history", "worker"]);
  const filtered = await suggest("/pbot st");
  assert.deepEqual(filtered.items.map(item => item.value), ["status"]);
  const completed = autocomplete.applyCompletion(["/pbot st"], 0, 8, filtered.items[0], filtered.prefix);
  assert.equal(completed.lines[0].trimEnd(), "/pbot status");
  for (const text of ["/pbot unknown", "/pbot upgrade", "/pbot init "]) {
    assert.equal(await suggest(text), null);
  }
});

for (const legacy of [undefined, '{"format":"legacy/1","status":"pending"}', "invalid historical JSON"]) {
  test("an opted-in workspace enables pbot_history, registers unified MCP server, and preserves legacy state: " + (legacy ?? "empty"), async t => {
    const { root, loader, session, errors, api } = await host(t, { prepare: async root => {
      if (legacy === undefined) return;
      await mkdir(join(root, ".legacy"));
      await writeFile(join(root, ".legacy/workspace.json"), legacy);
    } });
    assert.deepEqual(loader.getExtensions().warnings ?? [], []);
    const started = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, { cwd: root });
    assert.doesNotThrow(() => buildSystemPrompt(started.systemPromptOptions));
    const environment = JSON.parse(started.systemPromptOptions.sections.pbot_environment);
    assert.deepEqual(environment, { host: "pi", workspaceRoot: root, resourceRoot });
    assert.deepEqual(errors, []);
    assert.deepEqual(session.getAllTools().map(t => t.name).filter(n => n.startsWith("pbot_")).sort(), ["pbot_history"]);
    assert.ok(api.getMcpServers().some(server => server.name === "pbot"));
    assert.ok(loader.getSkills().skills.length > 0);
    assert.deepEqual((await readdir(root)).sort(), legacy === undefined ? [".pbot"] : [".legacy", ".pbot"]);
    if (legacy !== undefined) assert.equal(await readFile(join(root, ".legacy/workspace.json"), "utf8"), legacy);
    await session.prompt("/pbot init");
    assert.deepEqual(errors, []);
    await writeFile(join(root, "AGENTS.md"), "User instructions");
    await session.prompt("/pbot init");
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "User instructions");
    assert.deepEqual(session.getAllTools().map(t => t.name).filter(n => n.startsWith("pbot_")).sort(), ["pbot_history"]);
  });
}

async function runScript(session, id, code, signal) {
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
    const history = await tools.pbot_history({ action: "search" });
    return { names, namespace: namespace.name, history, output };
  `);
  const data = scriptValue(result);
  assert.deepEqual(data.names, ["pbot_history"]);
  assert.equal(data.namespace, "pbot");
  assert.equal(data.history.total, 0);
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
  const history = tools.find(t => t.name === "pbot_history");
  const found = await history.execute("history", { action: "search" });
  assert.ok(schema(history.outputSchema)(found.structuredContent));
  assert.equal(found.structuredContent.total, 0);
  await assert.rejects(history.execute("missing-node", { action: "read" }));
});

test("workspace shutdown invalidates previously acquired tools and unregisters MCP server", async t => {
  const { session, api } = await host(t);
  const history = session.agent.state.tools.find(t => t.name === "pbot_history");
  assert.ok(api.getMcpServers().some(server => server.name === "pbot"));
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await assert.rejects(history.execute("stale", { action: "search" }));
  assert.ok(!session.getCallableToolNames().includes("pbot_history"));
  assert.equal(api.getMcpServers().some(server => server.name === "pbot"), false);
});
