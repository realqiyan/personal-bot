import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { AgentFiles } from "../../dist/storage/agent-files.js";
import { acpInput, acpAnswer, acpReference } from "../../dist/storage/acp-files.js";
import piMember from "../../dist/extension/pi-acp-member.js";
import * as dshMember from "../../dist/extension/dsh/acp-member.js";
import { packageVersion } from "../../dist/common/version.js";
import { resourceRoot } from "../../dist/common/paths.js";
import { dshHost } from "../helpers/dsh-host.mjs";

async function fixture(t, backend = "pi") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-acp-member-"))), id = randomUUID(), generation = randomUUID();
  await mkdir(join(root, ".pbot")); await writeFile(join(root, ".pbot/config.json"), '{"enabled":true}');
  const files = new AgentFiles(join(root, "control"));
  files.create({ agentId: id, release: packageVersion, workspace: root, cwd: root, parentSessionId: "parent", parentLeaf: null,
    createdAt: 1, options: { noSkills: true } }, { generation, name: "member", sequence: 0, stop: false, startedAt: 1 },
  { host: "acp", backend, command: process.execPath, args: [], sessionId: null });
  const request = files.enqueue(id, "Local inspection", "steer");
  files.write(id, "acp-input.json", { generation, requestId: request.requestId }, acpInput);
  const env = { PBOT_SUBAGENT_RUN_ID: id, PBOT_SUBAGENT_DIR: files.directory(id), PBOT_SUBAGENT_GENERATION: generation, PBOT_ACP_PYTHON_STATE: "error" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, id, generation, files, request };
}

test("Pi ACP member loads first-task resources and never turns empty native output into a report", async t => {
  const { root, files, id, request } = await fixture(t), agentDir = join(root, "pi"); await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, extensionFactories: [piMember] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime,
    sessionManager: SessionManager.inMemory(root) });
  try {
    const errors = []; await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    const context = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Local inspection" }, { cwd: root });
    const environment = JSON.parse(context.systemPromptOptions.sections.pbot_environment);
    assert.equal(environment.workspaceRoot, root); assert.equal(environment.resourceRoot, resourceRoot); assert.equal(environment.python.state, "error");
    assert.ok(context.systemPromptOptions.sections.pbot_workspace); assert.ok(context.systemPromptOptions.sections.pbot_child);
    assert.deepEqual(session.getActiveToolNames().filter(name => name.startsWith("pbot_")), []);
    const denied = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "recursive", toolName: "pbot_agent", input: { action: "list" } });
    assert.equal(denied.block, true);
    await session.extensionRunner.emit({ type: "agent_settled", aborted: false });
    const answer = files.read(id, "acp-answer.json", acpAnswer);
    assert.equal(answer.requestId, request.requestId); assert.equal(answer.state, "failed"); assert.equal(answer.answer, "");
    assert.deepEqual(errors, []);
    files.write(id, "acp-session.json", { ...files.reference(id), sessionId: "foreign-session" }, acpReference);
    await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Check identity" }, { cwd: root });
    assert.ok(errors.some(error => error.event === "before_agent_start"));
  } finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
});

test("dsh ACP member composes first-task context and records actual local model-selection failure", async t => {
  const { root, files, id, request } = await fixture(t, "dsh");
  const host = await dshHost(join(root, "sessions"), { presets: true });
  try {
    await host.ctx.plugin(dshMember);
    const handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: "not-configured", model: "none" },
      setup: async scope => { await host.ctx.agentPresets.mount(scope, "pbot-test-standard"); } });
    const child = handle.agent;
    const names = host.ctx.tools.definitions(child).map(tool => tool.name);
    assert.ok(names.includes("read")); assert.ok(names.includes("write")); assert.equal(names.includes("subagent_fork"), false);
    assert.equal(names.includes("skill"), false);
    child.followup(createUserMessage({ content: [{ type: "text", text: "Local inspection" }], source: { kind: "user" } }));
    await child.whenIdle();
    const events = child.session.snapshotEvents();
    const environment = events.flatMap(event => event.type === "user/message" && event.data.source.kind === "runtime-context" ? event.data.source.sections : [])
      .find(section => section.name === "pbot:environment");
    assert.equal(JSON.parse(environment.text).workspaceRoot, root);
    assert.equal(JSON.parse(environment.text).python.state, "error");
    assert.ok(events.some(event => event.type === "system/message"));
    assert.equal(events.some(event => event.type === "assistant/message"), false);
    const answer = files.read(id, "acp-answer.json", acpAnswer);
    assert.equal(answer.requestId, request.requestId); assert.equal(answer.state, "failed"); assert.equal(answer.answer, "");
    await handle.dispose();
  } finally { await host.close(); }
});
