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

function messageText(message) { return message.content.filter(block => block.type === "text").map(block => block.text).join("\n"); }

async function fixture(t, backend, noSkills) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-acp-member-"))), id = randomUUID(), generation = randomUUID();
  const native = randomUUID(), role = randomUUID(), metadata = randomUUID(), method = randomUUID();
  await mkdir(join(root, ".pbot")); await writeFile(join(root, ".pbot/config.json"), '{"enabled":true}');
  await writeFile(join(root, "AGENTS.md"), native);
  await mkdir(join(root, "agents")); await writeFile(join(root, "agents/general-purpose.md"), role);
  await mkdir(join(root, ".agents/skills/local-check"), { recursive: true });
  await writeFile(join(root, ".agents/skills/local-check/SKILL.md"), `---\nname: local-check\ndescription: ${metadata}\n---\n${method}\n`);
  const files = new AgentFiles(join(root, "control"));
  files.create({ agentId: id, release: packageVersion, workspace: root, cwd: root, parentSessionId: "parent", parentLeaf: null,
    createdAt: 1, options: { noSkills } }, { generation, name: "member", sequence: 0, stop: false, startedAt: 1 },
  { host: "acp", backend, command: process.execPath, args: [], sessionId: null });
  const request = files.enqueue(id, "Local inspection", "steer");
  files.write(id, "acp-input.json", { generation, requestId: request.requestId }, acpInput);
  const env = { PBOT_SUBAGENT_RUN_ID: id, PBOT_SUBAGENT_DIR: files.directory(id), PBOT_SUBAGENT_GENERATION: generation, PBOT_ACP_PYTHON_STATE: "error" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, id, generation, files, request, native, role, metadata, method };
}

for (const noSkills of [false, true]) test(`Pi ACP member loads and refreshes native resources (noSkills=${noSkills})`, async t => {
  const { root, files, id, request, native, role, metadata, method } = await fixture(t, "pi", noSkills), agentDir = join(root, "pi"); await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills,
    extensionFactories: [piMember] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime,
    sessionManager: SessionManager.inMemory(root) });
  try {
    const errors = []; await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
    const prepare = () => session._prepareRun({ messageType: "user", prompt: "Local inspection" });
    const first = await prepare(), sections = session._runSystemPromptOptions.sections;
    const environment = JSON.parse(sections.pbot_environment);
    assert.equal(environment.workspaceRoot, root); assert.equal(environment.resourceRoot, resourceRoot); assert.equal(environment.python.state, "error");
    for (const marker of [native, role]) assert.equal(session.systemPrompt.split(marker).length - 1, 1);
    assert.equal(Object.hasOwn(sections, "pbot_team"), false);
    assert.equal(session.systemPrompt.includes(method), false);
    assert.equal(session.systemPrompt.includes(metadata), !noSkills);
    const paths = loader.getSkills().skills.map(skill => skill.filePath);
    assert.equal(paths.includes(join(root, ".agents/skills/local-check/SKILL.md")), !noSkills);
    assert.equal(paths.includes(join(resourceRoot, "skills/provider-connections/SKILL.md")), !noSkills);
    for (const message of first) session.sessionManager.appendMessage(message);
    session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    assert.equal((await prepare()).some(message => message.role === "system"), false);
    const updated = randomUUID(); await writeFile(join(root, "agents/general-purpose.md"), updated);
    await prepare();
    assert.equal(session.systemPrompt.split(updated).length - 1, 1);
    assert.equal(session.systemPrompt.includes(role), false);
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

for (const noSkills of [false, true]) test(`dsh ACP member loads and refreshes native resources (noSkills=${noSkills})`, async t => {
  const { root, files, id, request, native, role, method } = await fixture(t, "dsh", noSkills);
  const host = await dshHost(join(root, "sessions"), { presets: true });
  try {
    await host.ctx.plugin(dshMember);
    const handle = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: "not-configured", model: "none" },
      setup: async scope => { await host.ctx.agentPresets.mount(scope, "pbot-test-standard"); } });
    const child = handle.agent;
    const names = host.ctx.tools.definitions(child).map(tool => tool.name);
    assert.ok(names.includes("read")); assert.ok(names.includes("write")); assert.equal(names.includes("subagent_fork"), false);
    assert.equal(names.includes("skill"), !noSkills);
    child.followup(createUserMessage({ content: [{ type: "text", text: "Local inspection" }], source: { kind: "user" } }));
    await child.whenIdle();
    const events = child.session.snapshotEvents();
    const environment = events.flatMap(event => event.type === "user/message" && event.data.source.kind === "runtime-context" ? event.data.source.sections : [])
      .find(section => section.name === "pbot:environment");
    assert.equal(JSON.parse(environment.text).workspaceRoot, root);
    assert.equal(JSON.parse(environment.text).python.state, "error");
    const system = events.filter(event => event.type === "system/message").map(event => messageText(event.data.message)).join("\n");
    assert.equal(system.split(role).length - 1, 1);
    const instructions = events.filter(event => event.type === "user/message" && event.data.source.kind === "agent-instructions");
    assert.equal(instructions.length, 1); assert.equal(messageText(instructions[0].data).split(native).length - 1, 1);
    const catalogs = events.filter(event => event.type === "user/message" && event.data.source.kind === "skill-catalog");
    assert.equal(catalogs.length, noSkills ? 0 : 1);
    if (!noSkills) {
      const entries = catalogs[0].data.source.entries;
      assert.equal(entries.filter(entry => entry.name === "local-check").length, 1);
      assert.equal(entries.filter(entry => entry.name === "provider-connections").length, 1);
      const skill = await host.ctx.skills.get("local-check", { scope: child, cwd: root });
      assert.equal(skill.path, join(root, ".agents/skills/local-check/SKILL.md"));
    }
    assert.equal(events.filter(event => event.type === "user/message").some(event => messageText(event.data).includes(method)), false);
    assert.equal(events.some(event => event.type === "assistant/message"), false);
    const answer = files.read(id, "acp-answer.json", acpAnswer);
    assert.equal(answer.requestId, request.requestId); assert.equal(answer.state, "failed"); assert.equal(answer.answer, "");
    const updated = randomUUID(); await writeFile(join(root, "agents/general-purpose.md"), updated);
    const previous = child.session.snapshotEvents().length;
    child.followup(createUserMessage({ content: [{ type: "text", text: "Inspect updated resources" }], source: { kind: "user" } }));
    await child.whenIdle();
    const next = child.session.snapshotEvents().slice(previous);
    const refreshed = next.filter(event => event.type === "system/message").map(event => messageText(event.data.message)).join("\n");
    assert.equal(refreshed.split(updated).length - 1, 1); assert.equal(refreshed.includes(role), false);
    assert.equal(next.some(event => event.type === "user/message" && ["agent-instructions", "skill-catalog"].includes(event.data.source.kind)), false);
    await handle.dispose();
  } finally { await host.close(); }
});
