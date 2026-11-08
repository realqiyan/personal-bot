import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import guard from "../../dist/extension/setup-guard.js";

const [workspace, agentDir, source, enabled] = process.argv.slice(2);
const settingsManager = SettingsManager.inMemory({ packages: enabled === "yes" ? [source] : [] });
const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noContextFiles: true, extensionFactories: [guard] });
await loader.reload();
assert.equal(loader.getExtensions().errors.length, 0);
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const { session } = await createAgentSession({ cwd: workspace, agentDir, settingsManager, resourceLoader: loader,
  modelRuntime, model: modelRuntime.getModels("openai-codex")[0], sessionManager: SessionManager.inMemory(workspace) });
const errors = [];
try {
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error),
    commandContextActions: { waitForIdle: () => session.waitForIdle(), reload: () => session.reload() } });
  let disposition;
  await session.prompt("/pbot init", { preflightResult: value => { disposition = value; } });
  assert.equal(disposition, "handled");
  assert.equal(session.messages.length, 0);
  assert.deepEqual(errors, []);
  const files = await readdir(workspace);
  if (enabled === "yes") {
    assert.ok(files.includes("AGENTS.md"));
    assert.ok(session.getAllTools().some(tool => tool.name === "pbot_agent"));
    assert.ok(loader.getSkills().skills.length > 0);
  }
  else assert.deepEqual(files, []);
  console.log(JSON.stringify({ disposition, initialized: files.includes("AGENTS.md"), messages: session.messages.length }));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
