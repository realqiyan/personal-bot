import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dshHost } from "../helpers/dsh-host.mjs";
import * as pbot from "../../dist/dsh.js";
import { preparePythonFailure } from "../helpers/python-home.mjs";

async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "native execution did not settle"); await delay(20); }
}

test("native management reads preserve sessions, retain full records after stop, and reject foreign or disposed owners", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-management-")));
  const saved = { DSH_HOME: process.env.DSH_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  const { directory: venv, environment } = await preparePythonFailure(join(root, "user"));
  Object.assign(process.env, environment, { DSH_HOME: join(root, "home") });
  const host = await dshHost(join(root, "sessions")), signal = new AbortController().signal;
  try {
    const extension = await host.ctx.plugin(pbot);
    let management;
    await host.ctx.plugin({ inject: ["pbotManagement"], apply(ctx) { management = ctx.pbotManagement; } });
    const handles = [];
    for (let index = 0; index < 2; index++) handles.push(await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root },
      agentOptions: { provider: "not-configured", model: "none" } }));
    const parent = handles[0].agent, other = handles[1].agent;
    const run = async (verb, input, attachments = []) => {
      const output = await host.ctx.commands.execute(parent, "/pbot " + verb + " " + JSON.stringify(input), attachments, signal);
      assert.equal(output.result.kind, "success", output.result.text); return JSON.parse(output.result.text);
    };
    const created = await run("agent", { action: "start", name: "records" });
    const expert = host.ctx.agents.get(created.agentId); assert.ok(expert);
    const request = { parentSessionId: parent.id }, expertRequest = { ...request, input: { agentId: created.agentId } };
    const before = parent.session.snapshotEvents();
    assert.equal((await management.snapshot(request, signal)).agents.length, 1);
    assert.equal((await management.expert(expertRequest, signal)).total, 0);
    assert.deepEqual(parent.session.snapshotEvents(), before);
    assert.equal(expert.session.snapshotEvents().some(event => event.type === "turn/start"), false);
    await assert.rejects(management.expert({ parentSessionId: other.id, input: { agentId: created.agentId } }, signal));
    await assert.rejects(management.snapshot({ ...request, input: {} }, signal));
    const lock = join(process.env.DSH_HOME, "pbot/subagents/.control");
    await mkdir(lock);
    try {
      await assert.rejects(host.ctx.commands.execute(parent, "/pbot chat " + JSON.stringify({ agentId: created.agentId, text: "must not enter" }), [], signal),
        { code: "PBOT_CONTROL_BUSY" });
      assert.equal(parent.session.snapshotEvents().at(-1).data.kind, "error");
      assert.deepEqual(expert.session.snapshotEvents(), []);
    } finally { await rm(lock, { recursive: true }); }
    parent.model.select({ provider: "not-configured", model: "none", reasoningEffort: "high" });
    const different = await run("agent", { action: "start", name: "different route", model: "different-model" });
    assert.equal(host.ctx.agents.get(different.agentId).model.current().reasoningEffort, undefined);
    // Real native model admission fails against a genuinely absent provider. No provider or model is simulated.
    const privateText = "人工对话 🧪 " + randomUUID();
    await run("chat", { agentId: created.agentId, text: privateText }, [{ type: "image", mediaType: "image/png", name: "native-web-image.png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC" }]);
    await until(() => expert.session.snapshotEvents().some(event => event.type === "turn/end"));
    await expert.whenIdle();
    const native = expert.session.snapshotEvents();
    const picture = native.filter(event => event.type === "agent/inbox/spliced").flatMap(event => event.data.inserted)
      .flatMap(message => message.content).find(block => block.type === "image");
    assert.ok(picture);
    const stored = await host.ctx.attachments.readImage(picture.attachment);
    assert.equal(stored.ref.width, 1); assert.equal(stored.ref.height, 1);
    const entry = native.find(event => JSON.stringify(event).includes(privateText)); assert.ok(entry);
    let offset = 0, complete = "";
    do {
      const page = await management.expert({ ...request, input: { agentId: created.agentId, seq: entry.seq, textOffset: offset, textLimit: 13 } }, signal);
      complete += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(JSON.parse(complete), entry);
    const mainEvents = parent.session.snapshotEvents();
    assert.equal(mainEvents.some(event => event.type === "command/run" && "args" in event.data), false);
    assert.equal(JSON.stringify(mainEvents).includes(privateText), false);
    assert.ok(native.some(event => event.type === "agent/inbox/spliced" && event.data.inserted.some(message => message.source.kind === "user")));
    await management.history({ ...request, input: { action: "search", query: privateText, host: "dsh" } }, signal);
    assert.deepEqual(parent.session.snapshotEvents(), mainEvents);
    assert.deepEqual(expert.session.snapshotEvents(), native);
    await run("agent", { action: "stop", agentId: created.agentId });
    await until(() => !host.ctx.agents.get(created.agentId));
    const persisted = (await host.ctx.sessionQuery.readSession(created.agentId)).events;
    const cold = await management.expert(expertRequest, signal);
    assert.equal(cold.total, persisted.length); assert.equal(host.ctx.agents.get(created.agentId), undefined);
    assert.deepEqual((await host.ctx.sessionQuery.readSession(created.agentId)).events, persisted);
    // Native ownership, not just the optional origin label, excludes child Agents from coordinator management.
    const unlabeled = await host.ctx.agents.create({ sessionId: randomUUID(), parentAgent: parent, meta: { cwd: root } });
    await assert.rejects(management.snapshot({ parentSessionId: unlabeled.agent.id }, signal));
    await unlabeled.dispose();
    assert.ok(host.ctx.typert.local.get("pbot/snapshot"));
    await extension.dispose();
    assert.equal(host.ctx.typert.local.get("pbot/snapshot"), undefined);
    await assert.rejects(management.snapshot(request, signal));
    assert.equal(await readFile(join(venv, "keep"), "utf8"), "unrelated data");
    for (const handle of handles) await handle.dispose();
  } finally {
    await host.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
