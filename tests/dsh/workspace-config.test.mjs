import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import * as pbot from "../../dist/dsh.js";
import { initializeWorkspaceConfig, workspaceConfigPath } from "../../dist/services/workspace/workspace-config.js";
import { dshHost } from "../helpers/dsh-host.mjs";
import { preparePythonFailure } from "../helpers/python-home.mjs";

test("one dsh profile applies workspace opt-in independently, including reload and malformed configuration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-config-")));
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, DSH_HOME: process.env.DSH_HOME };
  const { environment } = await preparePythonFailure(join(root, "user"));
  Object.assign(process.env, environment, { DSH_HOME: join(root, "home") });
  const host = await dshHost(join(root, "sessions"), { presets: true });
  const signal = new AbortController().signal;
  try {
    const onebase = join(root, "onebase"), other = join(root, "other"), nested = join(onebase, "projects", "child"), invalid = join(root, "invalid");
    for (const directory of [onebase, other, nested, invalid]) await mkdir(directory, { recursive: true });
    await initializeWorkspaceConfig(onebase);
    await initializeWorkspaceConfig(invalid);
    await writeFile(workspaceConfigPath(invalid), '{"enabled":"true"}');
    const create = cwd => host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: "pbot-test-standard" },
      setup: async ctx => { await host.ctx.agentPresets.mount(ctx, "pbot-test-standard"); } });
    const handles = [await create(onebase), await create(other)];
    let extension = await host.ctx.plugin(pbot);
    handles.push(await create(nested), await create(invalid));
    const status = async agent => JSON.parse((await host.ctx.commands.execute(agent, "/pbot status", [], signal)).result.text);
    for (let index = 0; index < handles.length; index++) {
      const agent = handles[index].agent, enabled = index === 0;
      const view = await status(agent);
      assert.equal(view.enabled, enabled);
      assert.equal(view.state, index === 3 ? "error" : enabled ? "running" : "disabled");
      if (!enabled && index !== 3) assert.equal(view.nextStep, "/pbot init");
      assert.equal(host.ctx.tools.definitions(agent).some(tool => tool.name === "pbot_agent"), enabled);
      assert.ok(host.ctx.tools.definitions(agent).some(tool => tool.name === "read"));
      const skills = await host.ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd });
      assert.equal(skills.some(skill => skill.provider === "pbot"), enabled);
      const context = await host.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
      assert.equal(context.sections.some(section => section.name === "pbot:workspace"), enabled);
      assert.equal(agent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
    }
    assert.equal(typeof (await status(handles[3].agent)).configuration.error, "string");
    await assert.rejects(host.ctx.commands.execute(handles[1].agent, '/pbot agent {"action":"list"}', [], signal));
    assert.deepEqual(await readdir(other), []);
    assert.deepEqual(await readdir(nested), []);
    const sibling = await create(other); handles.push(sibling);
    const initialized = await Promise.all([handles[1].agent, sibling.agent].map(agent =>
      host.ctx.commands.execute(agent, "/pbot init", [], signal)));
    for (const result of initialized) assert.equal(JSON.parse(result.result.text).state, "running");
    assert.equal((await status(sibling.agent)).enabled, true);
    assert.ok(host.ctx.tools.definitions(sibling.agent).some(tool => tool.name === "pbot_agent"));
    assert.equal((await status(handles[2].agent)).enabled, false);
    assert.deepEqual(JSON.parse(await readFile(workspaceConfigPath(other), "utf8")), { enabled: true });
    await assert.rejects(host.ctx.commands.execute(handles[3].agent, "/pbot init", [], signal));
    assert.equal(await readFile(workspaceConfigPath(invalid), "utf8"), '{"enabled":"true"}');
    await writeFile(workspaceConfigPath(onebase), '{"enabled":false}');
    await initializeWorkspaceConfig(other);
    // Current instances keep their captured configuration until the native component is reloaded.
    assert.equal((await status(handles[0].agent)).enabled, true);
    await extension.dispose();
    extension = await host.ctx.plugin(pbot);
    assert.equal((await status(handles[0].agent)).enabled, false);
    assert.equal((await status(handles[1].agent)).enabled, true);
    assert.equal(host.ctx.tools.definitions(handles[0].agent).some(tool => tool.name === "pbot_agent"), false);
    assert.equal(host.ctx.tools.definitions(handles[1].agent).some(tool => tool.name === "pbot_agent"), true);
    await extension.dispose();
    for (const handle of handles) await handle.dispose();
  } finally {
    await host.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
