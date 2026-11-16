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
import { AgentBackends } from "../../dist/integrations/acp/agents.js";
import { PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { acpLaunch } from "../../dist/integrations/acp/launch.js";
import { acpContent } from "../../dist/integrations/acp/input.js";
import { launch } from "../../dist/storage/agent-files.js";
import { acpModelState, acpPermission, acpPermissionReply, acpReference, acpReport } from "../../dist/storage/acp-files.js";
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
  const host = new AgentBackends(new PiAgents(), directory, commands);
  const service = new AgentService(root, directory, host);
  t.after(async () => {
    await service.close(owner);
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, host, service, files: service.files };
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

test("ACP launch configuration validates the target and keeps native model defaults separate", async t => {
  const { root, service } = await fixture(t);
  const before = service.list(owner);
  await assert.rejects(service.start({ backend: "dsh", noExtensions: true }, owner));
  assert.deepEqual(service.list(owner), before);
  assert.throws(() => acpLaunch("claude", { claude: { command: process.execPath, args: [] } }, { provider: "pi-provider" }));
  const ref = acpLaunch("pi", { pi: { command: process.execPath, args: ["--version"] } }, {});
  assert.equal(ref.command, await realpath(process.execPath)); assert.equal(ref.sessionId, null);
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true, acp: { dsh: { command: "dsh", args: ["--profile", "acp"] } } }));
  assert.equal((await readWorkspaceConfig(root)).acp.dsh.command, "dsh");
  await writeFile(join(root, ".pbot/config.json"), '{"enabled":true,"acp":{"other":{"command":"x","args":[]}}}');
  assert.equal((await readWorkspaceConfig(root)).enabled, false);
});

test("real dsh ACP workers keep empty sessions across reload, stop and explicit restoration", async t => {
  const { root, directory, host, service, files } = await fixture(t);
  const created = await service.start({ backend: "dsh", name: "resident" }, owner);
  const ready = await until(() => service.status(created.agentId, owner), value => value.state === "idle" || value.state === "error");
  assert.equal(ready.state, "idle", ready.error);
  assert.equal(ready.transport, "acp"); assert.equal(ready.capabilities.resume, true); assert.equal(ready.capabilities.team, false);
  const model = files.read(created.agentId, "acp-model.json", acpModelState);
  assert.equal(model.generation, ready.generation); assert.equal(typeof ready.selection.model, "string");
  assert.equal(Object.hasOwn(ready.selection, "generation"), false);
  files.write(created.agentId, "acp-model.json", { ...model, generation: randomUUID() }, acpModelState);
  assert.equal(service.status(created.agentId, owner).selection, undefined);
  files.write(created.agentId, "acp-model.json", model, acpModelState);
  assert.deepEqual(service.status(created.agentId, owner).selection, ready.selection);
  assert.deepEqual(service.cycles(created.agentId, owner), []);
  const permissionId = randomUUID();
  files.write(created.agentId, "permissions/" + permissionId + ".json", { generation: ready.generation, requestId: permissionId, description: "Review this local operation",
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] }, acpPermission, true);
  assert.equal(service.pendingPermissions(owner).length, 1);
  assert.throws(() => service.answerPermission(created.agentId, permissionId, "unlisted", owner));
  service.answerPermission(created.agentId, permissionId, "allow", owner);
  assert.equal(files.read(created.agentId, "permissions/" + permissionId + "-reply.json", acpPermissionReply).optionId, "allow");
  assert.equal(service.pendingPermissions(owner).length, 0);
  const reference = files.reference(created.agentId); assert.equal(reference.host, "acp"); assert.notEqual(reference.sessionId, created.agentId);
  assert.equal(JSON.parse(await readFile(join(directory, created.agentId, "descriptor.json"), "utf8")).options.backend, undefined);
  const reopened = new AgentService(root, directory, new AgentBackends(new PiAgents(), directory));
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
  const page = await service.recordPage(created.agentId, owner);
  assert.equal(page.kind, "acp"); assert.equal(page.total, 4);
  service.stop(created.agentId, owner);
  await until(() => service.status(created.agentId, owner), value => value.state === "stopped");
  const resumed = await service.resume(created.agentId, "Only the new task", owner);
  await until(() => service.cycles(created.agentId, owner), values => values.some(c => c.requestIds.includes(resumed.requestId) && c.state !== "running"));
  assert.equal(service.cycles(created.agentId, owner).length, 3);
  assert.equal(files.messages(created.agentId).length, 3);
  assert.equal((await service.read(created.agentId, owner, before[0].cycleId)).report, firstReport.report);
});

test("ACP report references remain fixed and permission replies require the current owner and generation", async t => {
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
  const requestId = randomUUID();
  files.write(id, "permissions/" + requestId + ".json", { generation, requestId, description: "Local operation",
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] }, acpPermission, true);
  assert.throws(() => service.answerPermission(id, requestId, "allow", owner));
  assert.equal(files.optional(id, "permissions/" + requestId + "-reply.json", acpPermissionReply), undefined);
  assert.equal(files.read(id, "launch.json", launch).generation, generation);
  assert.throws(() => acpReference({ host: "acp", backend: "claude", command: "relative", args: [], sessionId: "x" }));
});
