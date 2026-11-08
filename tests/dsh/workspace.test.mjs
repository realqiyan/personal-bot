import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dshHost } from "../helpers/dsh-host.mjs";
import * as pbot from "../../dist/dsh.js";
import { initializeWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";
import { preparePythonFailure } from "../helpers/python-home.mjs";

// The real setup script encounters unrelated data and refuses to install anything.
// This exercises visible preparation failure without touching the user's venv.
test("dsh commands bind each parent to its workspace and unload invalidates captured handlers", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-workspace-")));
  const before = process.env.XDG_DATA_HOME, beforeDsh = process.env.DSH_HOME, beforeHome = process.env.HOME;
  const { directory: venv, environment } = await preparePythonFailure(join(root, "user"));
  Object.assign(process.env, environment, { DSH_HOME: join(root, "dsh-home") });
  const host = await dshHost(join(root, "sessions"));
  try {
    const extension = await host.ctx.plugin(pbot);
    const roots = [join(root, "a"), join(root, "b")];
    const parents = [];
    for (const cwd of roots) {
      await mkdir(cwd);
      await initializeWorkspaceConfig(cwd);
      parents.push(await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd } }));
    }
    const run = (agent, line) => host.ctx.commands.execute(agent, line, [], new AbortController().signal);
    for (let i = 0; i < parents.length; i++) {
      const value = await run(parents[i].agent, "/pbot status");
      assert.equal(value.result.kind, "success");
      assert.equal(JSON.parse(value.result.text).workspaceRoot, roots[i]);
      await assert.rejects(access(join(roots[i], "AGENTS.md")), { code: "ENOENT" });
      const events = (await host.ctx.sessionQuery.readSession(parents[i].agent.id)).events;
      assert.equal(events.some(e => e.type === "turn/start"), false);
    }
    const first = parents[0].agent;
    await parents[0].dispose();
    assert.equal(host.ctx.agents.get(parents[1].agent.id), parents[1].agent);
    const created = await run(parents[1].agent, "/pbot init");
    assert.equal(created.result.kind, "success");
    assert.ok((await readFile(join(roots[1], "AGENTS.md"), "utf8")).length > 0);
    await assert.rejects(access(join(roots[0], "AGENTS.md")), { code: "ENOENT" });
    const definition = host.ctx.commands.find(parents[1].agent, "pbot");
    assert.ok(definition);
    await assert.rejects(definition.handler({ agent: first, rawInput: "status", attachments: [], signal: new AbortController().signal }));
    await extension.dispose();
    assert.equal(host.ctx.commands.find(parents[1].agent, "pbot"), undefined);
    await assert.rejects(definition.handler({ agent: parents[1].agent, rawInput: "status", attachments: [], signal: new AbortController().signal }));
    assert.equal(await readFile(join(venv, "keep"), "utf8"), "unrelated data");
    await parents[1].dispose();
  } finally {
    await host.close();
    if (before === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = before;
    if (beforeDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = beforeDsh;
    if (beforeHome === undefined) delete process.env.HOME; else process.env.HOME = beforeHome;
    await rm(root, { recursive: true, force: true });
  }
});
