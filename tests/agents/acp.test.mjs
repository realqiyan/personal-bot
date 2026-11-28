import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { AgentRun } from "../../dist/services/agents/agent-run.js";
import { AcpAnswerBuffer } from "../../dist/services/agents/acp-run.js";
import { AcpWorkerHost } from "../../dist/integrations/acp/agents.js";
import { acpLaunch, canonicalAcpBackend, filterAcpStartOptions, inspectAcpBackends } from "../../dist/integrations/acp/launch.js";
import { acpHarnesses, registerAcpHarness } from "../../dist/integrations/acp/registry.js";
import { acpModelSelection, acpModelValue } from "../../dist/integrations/acp/model-selection.js";
import { acpContent } from "../../dist/integrations/acp/input.js";
import { AgentFiles, launch } from "../../dist/storage/agent-files.js";
import { acpModelState, acpReference, acpReport } from "../../dist/storage/acp-files.js";
import { packageVersion } from "../../dist/common/version.js";
import { readWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";

const owner = { sessionId: "parent", leaf: "anchor", branch: ["anchor"] };
async function until(read, accept) {
  const deadline = Date.now() + 15000;
  do { const value = await read(); if (accept(value)) return value; await delay(30); } while (Date.now() < deadline);
  assert.fail("ACP operation did not settle: " + JSON.stringify(await read()));
}
async function fixture(t, keyless = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-acp-"))), directory = join(root, "control");
  await mkdir(join(root, ".pbot")); await writeFile(join(root, ".pbot/config.json"), '{"enabled":true}');
  const environment = { HOME: join(root, "user"), XDG_DATA_HOME: join(root, "data"),
    DSH_HOME: join(root, "dsh"), DSH_AGENTS_HOME: join(root, "agents") };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const commands = { dsh: keyless ? { command: process.execPath, args: [new URL("../helpers/dsh-acp-driver.mjs", import.meta.url).pathname] }
    : { command: new URL("../../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url).pathname, args: ["--profile", "acp"] } };
  const host = new AcpWorkerHost(directory, commands);
  const service = new AgentService(root, directory, host);
  t.after(async () => {
    await service.close(owner);
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, host, service, files: new AgentFiles(directory) };
}

test("ACP output keeps the final message across deltas and late tool status updates", () => {
  const answer = new AcpAnswerBuffer();
  answer.update({ kind: "text", messageId: "explanation", text: "I will read the file" });
  answer.update({ kind: "tool", activity: "read" });
  assert.equal(answer.text, "");
  answer.update({ kind: "text", messageId: "answer", text: "Final " });
  answer.update({ kind: "text", messageId: "answer", text: "answer" });
  answer.update({ kind: "activity", activity: "completed" });
  answer.update({ kind: "thought", text: "Internal thought" });
  assert.equal(answer.text, "Final answer");
  answer.update({ kind: "text", messageId: "next", text: "Next message" });
  assert.equal(answer.text, "Next message");
  answer.reset(); assert.equal(answer.text, "");
});

test("ACP attachments preserve source files, binary links and image bytes without filename extensions", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-acp-input-")); t.after(() => rm(root, { recursive: true, force: true }));
  const textFile = join(root, "text"), imageFile = join(root, "image"), binaryFile = join(root, "binary");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkN8AAAAASUVORK5CYII=", "base64");
  await writeFile(textFile, "content".repeat(12000)); await writeFile(imageFile, image); await writeFile(binaryFile, Buffer.from([0, 1, 2, 255]));
  const request = { requestId: randomUUID(), generation: randomUUID(), sequence: 1, message: "Use these files", delivery: "steer", files: [textFile, imageFile, binaryFile] };
  const content = await acpContent(request, true, new AbortController().signal);
  assert.deepEqual(content[0], { type: "text", text: request.message });
  const raster = content.find(block => block.type === "image"); assert.equal(raster.mimeType, "image/png"); assert.deepEqual(Buffer.from(raster.data, "base64"), image);
  assert.equal(content.find(block => block.type === "resource_link").uri, new URL("file://" + binaryFile).href);
  assert.ok(content.filter(block => block.type === "text").some(block => block.text.includes(textFile)));
  await assert.rejects(acpContent(request, false, new AbortController().signal));
  await assert.rejects(acpContent(request, true, AbortSignal.abort()));
});

test("ACP harness registry is dynamically extensible without changing runtime code", async t => {
  const { root } = await fixture(t);
  assert.deepEqual(filterAcpStartOptions("dsh", { noExtensions: true, noSkills: true, provider: "p", model: "m" }),
    { provider: "p", model: "m" });
  assert.deepEqual(filterAcpStartOptions("claude", { provider: "p", model: "m", tools: ["read"], noSkills: true, noExtensions: true }),
    { model: "m" });
  assert.throws(() => acpLaunch("claude", { claude: { command: process.execPath, args: [] } }, { provider: "pi-provider" }));
  const ref = acpLaunch("pi", { pi: { command: process.execPath, args: ["--version"] } }, {});
  assert.equal(ref.command, await realpath(process.execPath)); assert.equal(ref.sessionId, null);

  // Register a custom specialized ACP harness dynamically at runtime.
  registerAcpHarness({
    id: "ext-harness",
    defaultCommand: { command: process.execPath, args: ["--version"] },
    parseModelValue: value => {
      const [provider, model] = value.split(":");
      return model ? { provider, model } : { model: value };
    },
    formatModelQuery: (model, provider) => provider ? `${provider}:${model}` : undefined,
  });
  t.after(() => acpHarnesses.unregister("ext-harness"));

  const extOptions = [{ id: "model", category: "model", type: "select", name: "model", currentValue: "acme:pro",
    options: [{ value: "acme:pro", name: "Pro" }, { value: "other:pro", name: "Other Pro" }] }];
  assert.equal(acpModelValue("ext-harness", extOptions, "pro", "other").value, "other:pro");
  assert.deepEqual(acpModelSelection("ext-harness", extOptions), { provider: "acme", model: "pro" });
  assert.ok(inspectAcpBackends().some(item => item.backend === "ext-harness" && item.available));

  // Arbitrary un-registered custom harness in .pbot/config.json resolves via generic ACP v1 with optional env.
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    acp: {
      dsh: { command: "dsh", args: ["--profile", "acp"] },
      "custom-harness": { command: process.execPath, args: [], env: { CUSTOM_FLAG: "1" } },
    },
  }));
  const loaded = await readWorkspaceConfig(root);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.acp["custom-harness"].env.CUSTOM_FLAG, "1");
  const customRef = acpLaunch("custom-harness", loaded.acp, {});
  assert.equal(customRef.backend, "custom-harness");
  assert.equal(customRef.command, await realpath(process.execPath));
  assert.deepEqual(customRef.env, { CUSTOM_FLAG: "1" });
  assert.equal(canonicalAcpBackend("Claude Code"), "claude");
  assert.equal(canonicalAcpBackend("OpenAI Codex"), "codex");
  assert.equal(canonicalAcpBackend("Qoder CLI"), "qoder");
  assert.equal(canonicalAcpBackend("qodercli"), "qoder");
  assert.deepEqual(acpHarnesses.get("qoder").defaultCommand, { command: "qodercli", args: ["--acp"] });
  assert.equal(canonicalAcpBackend("AGY"), "antigravity");
  assert.equal(canonicalAcpBackend("claude-code", { "claude-code": { command: process.execPath, args: [] } }), "claude-code");
  const permRef = acpLaunch("claude", { claude: { command: process.execPath, permission: "allow" } }, {});
  assert.equal(permRef.permission, "allow");
  await writeFile(join(root, ".pbot/config.json"), '{"enabled":true,"acp":{"Bad_Name":{"command":"x","args":[]}}}');
  assert.equal((await readWorkspaceConfig(root)).enabled, false);
});

test("real dsh ACP workers keep empty sessions across reload, stop and explicit restoration", async t => {
  const { root, directory, host, service, files } = await fixture(t);
  const created = await service.start({ backend: "dsh", name: "resident" }, owner);
  const ready = await until(() => service.status(created.agentId, owner), value => value.state === "idle" || value.state === "error");
  assert.equal(ready.state, "idle", ready.error);
  assert.equal(ready.transport, "acp"); assert.equal(ready.capabilities.resume, true);
  const model = files.read(created.agentId, "acp-model.json", acpModelState);
  assert.equal(model.generation, ready.generation); assert.equal(typeof ready.selection.model, "string");
  assert.equal(Object.hasOwn(ready.selection, "generation"), false);
  files.write(created.agentId, "acp-model.json", { ...model, generation: randomUUID() }, acpModelState);
  assert.equal(service.status(created.agentId, owner).selection, undefined);
  files.write(created.agentId, "acp-model.json", model, acpModelState);
  assert.deepEqual(service.status(created.agentId, owner).selection, ready.selection);
  assert.deepEqual(service.cycles(created.agentId, owner), []);
  const reference = files.reference(created.agentId); assert.equal(reference.host, "acp"); assert.notEqual(reference.sessionId, created.agentId);
  assert.equal(JSON.parse(await readFile(join(directory, created.agentId, "descriptor.json"), "utf8")).options.backend, undefined);
  const reopened = new AgentService(root, directory, new AcpWorkerHost(directory));
  assert.equal(reopened.status(created.agentId, owner).state, "idle");
  await reopened.close(owner, true); assert.equal(host.alive(created.agentId), true);
  const stoppingAt = Date.now();
  service.stop(created.agentId, owner);
  await until(() => service.status(created.agentId, owner), value => value.state === "stopped");
  assert.ok(Date.now() - stoppingAt < 3000, "an idle ACP worker should exit without the four-second prompt grace timer");
  const generation = ready.generation;
  await service.enter(created.agentId, owner);
  const restored = await until(() => service.status(created.agentId, owner), value => value.state === "idle" || value.state === "error");
  assert.equal(restored.state, "idle", restored.error); assert.notEqual(restored.generation, generation);
  assert.equal(files.reference(created.agentId).sessionId, reference.sessionId);
  assert.deepEqual(service.cycles(created.agentId, owner), []);
  await host.release(created.agentId, generation); assert.equal(host.alive(created.agentId), true);
});

test("failed ACP configuration cannot restore a session using native defaults", async t => {
  const { service, host, files } = await fixture(t);
  for (const options of [{ model: "unavailable-pbot-model" }, { thinking: "unavailable-pbot-effort" }]) {
    const created = await service.start({ backend: "dsh", ...options }, owner);
    const failed = await until(() => service.status(created.agentId, owner), value => value.state === "error" && !host.alive(created.agentId));
    await service.enter(created.agentId, owner);
    const restored = await until(() => service.status(created.agentId, owner), value => value.state === "idle" || (value.state === "error" && !host.alive(created.agentId)));
    assert.equal(restored.state, "error");
    assert.notEqual(restored.generation, failed.generation);
    assert.equal(files.reference(created.agentId).sessionId, null);
    assert.deepEqual(service.cycles(created.agentId, owner), []);
  }
});

test("a real missing-model failure seals one ACP cycle and resume never repeats old requests", async t => {
  const { service, files } = await fixture(t, true);
  const created = await service.start({ backend: "dsh", message: "Inspect local workspace" }, owner);
  assert.throws(() => service.send(created.agentId, "Steer while starting", "steer", owner));
  const next = service.send(created.agentId, "Second request", "followUp", owner);
  await until(() => service.cycles(created.agentId, owner), values => values.some(c => c.requestIds.includes(next.requestId) && c.state !== "running"));
  const before = service.cycles(created.agentId, owner);
  assert.equal(before.length, 2); assert.ok(before.every(c => c.state === "failed"));
  assert.deepEqual(before.flatMap(c => c.requestIds).sort(), [created.requestId, next.requestId].sort());
  const firstReport = await service.read(created.agentId, owner, before[0].cycleId);
  assert.equal(firstReport.cycle.state, "failed"); assert.equal(firstReport.report, "");
  service.stop(created.agentId, owner);
  await until(() => service.status(created.agentId, owner), value => value.state === "stopped");
  const resumed = await service.resume(created.agentId, "Only the new task", owner);
  await until(() => service.cycles(created.agentId, owner), values => values.some(c => c.requestIds.includes(resumed.requestId) && c.state !== "running"));
  assert.equal(service.cycles(created.agentId, owner).length, 3);
  assert.equal(files.messages(created.agentId).length, 3);
  assert.equal((await service.read(created.agentId, owner, before[0].cycleId)).report, firstReport.report);
});

test("ACP report references remain fixed and isolated by owner", async t => {
  const { root, service, files } = await fixture(t);
  const id = randomUUID(), generation = randomUUID();
  files.create({ agentId: id, release: packageVersion, workspace: root, cwd: root, parentSessionId: owner.sessionId,
    parentLeaf: owner.leaf, createdAt: 1, options: {} }, { generation, name: "records", sequence: 0, stop: false, startedAt: 1 },
  { host: "acp", backend: "claude", command: process.execPath, args: [], sessionId: "native-session", capabilities: { resume: true, load: true, close: true } });
  const execution = new AgentRun(files, id, generation);
  const request = files.enqueue(id, "First request", "steer"); execution.claim(request.requestId); execution.consume(request.requestId); execution.begin();
  const cycleId = execution.current.cycleId;
  files.write(id, "reports/" + cycleId + ".json", { generation, cycleId, text: "First report😀with content" }, acpReport, true);
  execution.finish({ state: "completed", position: "acp:" + cycleId, answer: "First report😀with content" });
  const first = await service.read(id, owner, cycleId, 0, 5); assert.equal(first.report, "First"); assert.equal(first.nextOffset, 5);
  const next = files.enqueue(id, "Next request", "followUp"); execution.claim(next.requestId); execution.consume(next.requestId); execution.begin();
  const later = execution.current.cycleId;
  files.write(id, "reports/" + later + ".json", { generation, cycleId: later, text: "Later report" }, acpReport, true);
  execution.finish({ state: "completed", position: "acp:" + later, answer: "Later report" });
  assert.equal((await service.read(id, owner, cycleId)).report, "First report😀with content");
  assert.equal((await service.read(id, owner)).report, "Later report");
  assert.throws(() => service.status(id, { ...owner, branch: [] }));
  await assert.rejects(service.read(id, owner, "missing"));
  assert.equal(files.read(id, "launch.json", launch).generation, generation);
  assert.throws(() => acpReference({ host: "acp", backend: "claude", command: "relative", args: [], sessionId: "x" }));
});
