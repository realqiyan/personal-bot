import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access, symlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAgentSession, SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { join } from "node:path";
import { host } from "../helpers/pi-host.mjs";
import { PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { agentFileTools } from "../../dist/integrations/pi/agent-tools.js";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { PythonEnvironmentService } from "../../dist/services/workspace/python-environment-service.js";
import { WorkspaceInstance } from "../../dist/extension/lifecycle.js";
import { Confirmations } from "../../dist/ui/confirmation.js";

async function fixture(t) {
  const { root, session } = await host(t);
  const confirmations = new Confirmations(), ctx = session.extensionRunner.createToolContext("local", undefined);
  const instance = new WorkspaceInstance(root, new PythonEnvironmentService(root),
    new AgentService(root, join(root, "agent-state"), new PiAgents()));
  t.after(() => instance.close());
  return { root, ctx, confirmations, instance };
}

test("native agent file tools allow workspace documents and reject outside writes before mkdir", async t => {
  const f = await fixture(t), cancel = f.instance.signal();
  const fileTools = agentFileTools(f.root, cancel, (path, change, signal) => f.instance.authorizeFile(path, change,
    value => f.confirmations.ask(f.ctx, "Outside write", value, signal), signal));
  const runtime = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: join(f.root, "models.json") });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: join(f.root, "agent"), settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: f.root, model: f.ctx.model, modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(f.root), settingsManager: SettingsManager.inMemory(),
    resourceLoader: loader, customTools: fileTools,
    tools: ["read", "bash", "write", "edit", "grep", "find", "ls"] });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  for (const tool of JSON.parse(JSON.stringify(convertResponsesTools(session.agent.state.tools)))) {
    assert.equal(tool.parameters.type, "object", tool.name);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(tool.parameters[keyword], undefined, tool.name);
  }
  const write = session.agent.state.tools.find(tool => tool.name === "write");
  const edit = session.agent.state.tools.find(tool => tool.name === "edit");
  await write.execute("artifact", { path: "projects/report.txt", content: "old" });
  await edit.execute("update", { path: "projects/report.txt", edits: [{ oldText: "old", newText: "new" }] });
  assert.equal(await readFile(join(f.root, "projects/report.txt"), "utf8"), "new");
  const outside = join(f.root, "../not-authorized/file.txt");
  await symlink(join(f.root, "../not-authorized"), join(f.root, "outside-alias"));
  for (const path of [outside, pathToFileURL(outside).href, "@" + outside, "outside-alias/file.txt"]) {
    await assert.rejects(write.execute("outside", { path, content: "outside" }));
  }
  await assert.rejects(access(join(f.root, "../not-authorized")));
});

test("workspace close cancels setup and invalidates access without changing user documents", async t => {
  const f = await fixture(t), service = f.instance.pythonEnvironment;
  await writeFile(join(f.root, "AGENTS.md"), "User instructions");
  const signal = f.instance.signal(), pending = service.setup(), rejected = assert.rejects(pending);
  await f.instance.close();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.throws(() => f.instance.check());
  assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "User instructions");
  await assert.rejects(access(join(f.root, ".pbot")), { code: "ENOENT" });
  await assert.rejects(service.setup());
});
