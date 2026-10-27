import assert from "node:assert/strict";
import { after } from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Exercise a real damaged shared environment: no network or user-environment writes in Node tests.
const previousDataHome = process.env.XDG_DATA_HOME;
const pythonDataHome = await mkdtemp(join(tmpdir(), "pbot-python-host-"));
await mkdir(join(pythonDataHome, "pbot/python/.venv"), { recursive: true });
process.env.XDG_DATA_HOME = pythonDataHome;
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousDataHome;
  await rm(pythonDataHome, { recursive: true, force: true });
});

export async function host(t, { prepare, enabled = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "pbot-pi-")), root = join(temp, "workspace"), agentDir = join(temp, "agent");
  await mkdir(root); await mkdir(agentDir);
  await prepare?.(root);
  const settingsManager = SettingsManager.inMemory({ packages: enabled ? [resolve(".")] : [], defaultTools: ["+codemode"] });
  let api;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ models: false }), pi => { api = pi; }] });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    modelRuntime: runtime, model: runtime.getModels("openai-codex")[0],
    sessionManager: SessionManager.create(root, join(temp, "sessions")) });
  const errors = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    await rm(temp, { recursive: true, force: true });
  });
  assert.deepEqual(errors, []);
  return { root, loader, session, errors, api };
}
