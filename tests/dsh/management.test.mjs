import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dshHost } from "../helpers/dsh-host.mjs";
import * as pbot from "../../dist/dsh.js";
import { initializeWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";

test("dsh management exposes snapshot, history, and /pbot worker while rejecting child sessions and disposed owners", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-management-")));
  const saved = { DSH_HOME: process.env.DSH_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  Object.assign(process.env, { HOME: join(root, "user"), XDG_DATA_HOME: join(root, "user/data"), DSH_HOME: join(root, "home") });
  await initializeWorkspaceConfig(root);
  const host = await dshHost(join(root, "sessions")), signal = new AbortController().signal;
  try {
    const extension = await host.ctx.plugin(pbot);
    let management;
    await host.ctx.plugin({ inject: ["pbotManagement"], apply(ctx) { management = ctx.pbotManagement; } });
    const parentHandle = await host.ctx.agents.create({
      sessionId: randomUUID(), meta: { cwd: root },
      agentOptions: { provider: "not-configured", model: "none" },
    });
    const parent = parentHandle.agent;
    const run = async (verb, input) => {
      const output = await host.ctx.commands.execute(parent, "/pbot " + verb + " " + JSON.stringify(input), [], signal);
      assert.equal(output.result.kind, "success", output.result.text);
      return JSON.parse(output.result.text);
    };
    const request = { parentSessionId: parent.id };
    const before = parent.session.snapshotEvents();
    const snap = await management.snapshot(request, signal);
    assert.equal(snap.enabled, true);
    assert.equal(snap.state, "running");
    assert.deepEqual(parent.session.snapshotEvents(), before);
    await assert.rejects(management.snapshot({ ...request, input: {} }, signal));

    const backends = await run("worker", { action: "backends" });
    assert.ok(Array.isArray(backends.backends) && backends.backends.length > 0);
    assert.deepEqual(await run("worker", { action: "status" }), { workers: [] });

    const historyResult = await management.history({ ...request, input: { action: "search", host: "dsh" } }, signal);
    assert.equal(historyResult.total, 0);

    // Child Agents never own coordinator management.
    const unlabeled = await host.ctx.agents.create({ sessionId: randomUUID(), parentAgent: parent, meta: { cwd: root } });
    await assert.rejects(management.snapshot({ parentSessionId: unlabeled.agent.id }, signal));
    await unlabeled.dispose();

    assert.ok(host.ctx.typert.local.get("pbot/snapshot"));
    assert.ok(host.ctx.typert.local.get("pbot/history"));
    assert.equal(host.ctx.typert.local.get("pbot/expert"), undefined);
    assert.equal(host.ctx.typert.local.get("pbot/team"), undefined);
    await extension.dispose();
    assert.equal(host.ctx.typert.local.get("pbot/snapshot"), undefined);
    await assert.rejects(management.snapshot(request, signal));
    await parentHandle.dispose();
  } finally {
    await host.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
