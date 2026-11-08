import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { host } from "../helpers/pi-host.mjs";

for (const [filter, expected] of [
  [{ skills: [] }, []],
  [{ skills: ["resources/skills/provider-connections"] }, ["provider-connections"]],
  [{ skills: ["!**", "+resources/skills/provider-connections"] }, ["provider-connections"]],
  [{ autoload: false, extensions: ["+src/pbot.ts"], skills: ["+resources/skills/provider-connections"] }, ["provider-connections"]],
]) {
  test("Pi applies package filters to workspace-owned skill discovery: " + JSON.stringify(filter), async t => {
    const { loader, session } = await host(t, { packageEntry: { source: resolve("."), ...filter } });
    assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), expected);
    assert.ok(session.getAllTools().some(tool => tool.name === "pbot_agent"));
  });
}

test("Pi first run includes native workspace files and local role, then emits only changed sections", async t => {
  const native = randomUUID(), local = randomUUID();
  const { root, session, loader, errors } = await host(t, { noContextFiles: false, prepare: async root => {
    await writeFile(join(root, "AGENTS.md"), native);
    await mkdir(join(root, "agents"));
    await writeFile(join(root, "agents/coordinator.md"), local);
  } });
  assert.ok(loader.getAgentsFiles().agentsFiles.some(file => file.path === join(root, "AGENTS.md")));
  // Observe the real SDK preparation before authentication/streaming, without generating responses.
  const prepare = () => session._prepareRun({ messageType: "user", prompt: "Local context inspection" });
  const first = await prepare();
  assert.ok(session.systemPrompt.includes(native));
  assert.ok(session.systemPrompt.includes(local));
  const sections = first.find(message => message.role === "system").sections;
  const environment = JSON.parse(session._runSystemPromptOptions.sections.pbot_environment);
  assert.equal(environment.workspaceRoot, root);
  assert.deepEqual(environment.python, { state: "error" });
  assert.equal(Object.hasOwn(environment, "cwd"), false);
  assert.equal(Object.hasOwn(sections, "pbot_team"), false);
  for (const message of first) session.sessionManager.appendMessage(message);
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  assert.equal((await prepare()).some(message => message.role === "system"), false);
  const replacement = randomUUID();
  await writeFile(join(root, "agents/coordinator.md"), replacement);
  const changed = (await prepare()).find(message => message.role === "system");
  assert.deepEqual(Object.keys(changed.sections), ["pbot"]);
  assert.ok(changed.sections.pbot.includes(replacement));
  assert.equal(changed.sections.pbot.includes(local), false);
  assert.deepEqual(errors, []);
});

test("Pi reload discovers the root navigation created by init without overwriting it", async t => {
  const { root, session, loader, errors } = await host(t, { noContextFiles: false });
  await session.prompt("/pbot init");
  assert.equal(loader.getAgentsFiles().agentsFiles.some(file => file.path === join(root, "AGENTS.md")), false);
  const userContent = randomUUID();
  await writeFile(join(root, "AGENTS.md"), userContent);
  await session.reload();
  assert.equal(loader.getAgentsFiles().agentsFiles.find(file => file.path === join(root, "AGENTS.md"))?.content, userContent);
  assert.deepEqual(errors, []);
});

test("Pi aborts before a provider request if a required role cannot be read", async t => {
  const { session, errors, api } = await host(t, { prepare: async root => {
    await mkdir(join(root, "agents/coordinator.md"), { recursive: true });
  } });
  let providerRequests = 0, abortedAtStart = false;
  api.on("before_provider_request", () => { providerRequests++; });
  api.on("agent_start", (_event, ctx) => { abortedAtStart = ctx.signal?.aborted === true; });
  // A real custom-message run exercises before_agent_start without provider credentials.
  // The resource failure must cancel it before the native provider stream is reached.
  await session.sendCustomMessage({ customType: "local-inspection", content: "Inspect required resources", display: false }, { triggerTurn: true });
  assert.ok(errors.some(error => error.event === "before_agent_start"));
  assert.equal(session.isIdle, true);
  assert.equal(providerRequests, 0);
  assert.equal(abortedAtStart, true);
  assert.ok(session.agent.state.messages.filter(message => message.role === "assistant").every(message =>
    ["aborted", "error"].includes(message.stopReason) && message.usage.totalTokens === 0));
});
