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

const expectedMcpTools = [
  "mcp__pbot__worker_create",
  "mcp__pbot__worker_close",
  "mcp__pbot__worker_request",
  "mcp__pbot__worker_response",
  "mcp__pbot__worker_output",
  "mcp__pbot__worker_discover",
];

test("one dsh profile applies workspace opt-in independently, mounts split MCP worker_* tools, and leaves native subagents intact", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-config-")));
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, DSH_HOME: process.env.DSH_HOME };
  Object.assign(process.env, { HOME: join(root, "user"), XDG_DATA_HOME: join(root, "user/data"), DSH_HOME: join(root, "home") });
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
      const toolNames = host.ctx.tools.definitions(agent).map(tool => tool.name);
      assert.equal(toolNames.includes("pbot_history"), enabled);
      for (const mcpTool of expectedMcpTools) assert.equal(toolNames.includes(mcpTool), enabled, mcpTool);
      assert.equal(toolNames.includes("mcp__pbot__pbot_worker"), false);
      assert.equal(toolNames.includes("pbot_agent"), false);
      assert.equal(toolNames.includes("pbot_team"), false);
      // Native tools including native subagent_fork stay untouched.
      assert.ok(toolNames.includes("read"));
      assert.ok(toolNames.includes("subagent_fork"));
      const skills = await host.ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd });
      assert.equal(skills.some(skill => skill.provider === "pbot"), enabled);
      const context = await host.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
      assert.equal(context.sections.some(section => section.name === "pbot:workspace"), enabled);
      assert.equal(agent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
    }
    assert.equal(typeof (await status(handles[3].agent)).configuration.error, "string");
    await assert.rejects(host.ctx.commands.execute(handles[1].agent, "/pbot worker status", [], signal));
    assert.deepEqual(await readdir(other), []);
    assert.deepEqual(await readdir(nested), []);
    const sibling = await create(other); handles.push(sibling);
    const initialized = await Promise.all([handles[1].agent, sibling.agent].map(agent =>
      host.ctx.commands.execute(agent, "/pbot init", [], signal)));
    for (const result of initialized) assert.equal(JSON.parse(result.result.text).state, "running");
    assert.equal((await status(sibling.agent)).enabled, true);
    assert.ok(host.ctx.tools.definitions(sibling.agent).some(tool => tool.name === "pbot_history"));
    for (const mcpTool of expectedMcpTools) {
      assert.ok(host.ctx.tools.definitions(sibling.agent).some(tool => tool.name === mcpTool), mcpTool);
    }
    assert.equal((await status(handles[2].agent)).enabled, false);
    assert.deepEqual(JSON.parse(await readFile(workspaceConfigPath(other), "utf8")), {
      enabled: true,
      features: { prompts: true, skills: true, mcp: true, history: true },
      summary: { backend: "pi", concurrency: 3 },
    });
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
    assert.equal(host.ctx.tools.definitions(handles[0].agent).some(tool => tool.name === "pbot_history"), false);
    for (const mcpTool of expectedMcpTools) {
      assert.equal(host.ctx.tools.definitions(handles[0].agent).some(tool => tool.name === mcpTool), false, mcpTool);
    }
    assert.equal(host.ctx.tools.definitions(handles[1].agent).some(tool => tool.name === "pbot_history"), true);
    for (const mcpTool of expectedMcpTools) {
      assert.equal(host.ctx.tools.definitions(handles[1].agent).some(tool => tool.name === mcpTool), true, mcpTool);
    }
    await extension.dispose();
    for (const handle of handles) await handle.dispose();
  } finally {
    await host.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

test("dsh mounts .pbot/mcp.json natively without duplicate workspace_mcp_* bridge tools and honors worker-only features toggles", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-dsh-mcp-features-")));
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, DSH_HOME: process.env.DSH_HOME };
  Object.assign(process.env, { HOME: join(root, "user"), XDG_DATA_HOME: join(root, "user/data"), DSH_HOME: join(root, "home") });
  const host = await dshHost(join(root, "sessions"), { presets: true });
  const signal = new AbortController().signal;
  try {
    const fullWs = join(root, "full");
    const workerOnlyWs = join(root, "worker-only");
    const stdioBin = join(root, "mini-mcp.mjs");
    await Promise.all([
      mkdir(join(fullWs, ".pbot"), { recursive: true }),
      mkdir(join(workerOnlyWs, ".pbot"), { recursive: true }),
      writeFile(stdioBin, `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c;
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "1.0.0" } } }) + "\\n");
    else if (msg.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping_tool", description: "Ping", inputSchema: { type: "object" } }] } }) + "\\n");
    else if (msg.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } }) + "\\n");
  }
});
`, { mode: 0o755 }),
    ]);
    await writeFile(workspaceConfigPath(fullWs), JSON.stringify({ enabled: true }));
    await writeFile(join(fullWs, ".pbot/mcp.json"), JSON.stringify({
      mcpServers: { mini: { command: process.execPath, args: [stdioBin] } },
    }));
    await writeFile(workspaceConfigPath(workerOnlyWs), JSON.stringify({
      enabled: true,
      features: { prompts: false, skills: false, mcp: false },
    }));
    await writeFile(join(workerOnlyWs, ".pbot/mcp.json"), JSON.stringify({
      mcpServers: { mini: { command: process.execPath, args: [stdioBin] } },
    }));

    const extension = await host.ctx.plugin(pbot);
    const create = cwd => host.ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd, agentPreset: "pbot-test-standard" },
      setup: async ctx => { await host.ctx.agentPresets.mount(ctx, "pbot-test-standard"); },
    });
    const fullHandle = await create(fullWs);
    const workerOnlyHandle = await create(workerOnlyWs);

    // Full workspace: `.pbot/mcp.json` is mounted natively ONLY; `workspace_mcp_*` bridge tools are suppressed to avoid duplication.
    const fullTools = host.ctx.tools.definitions(fullHandle.agent).map(tool => tool.name);
    assert.ok(fullTools.includes("mcp__mini__ping_tool"));
    assert.equal(fullTools.includes("mcp__pbot__workspace_mcp_discover"), false);
    assert.equal(fullTools.includes("mcp__pbot__workspace_mcp_call"), false);
    assert.ok(fullTools.includes("mcp__pbot__worker_create"));

    // Worker-only workspace: NO prompts, NO pbot skills, NO native mini MCP, NO workspace_mcp_*; ONLY worker_* stays active.
    const workerOnlyTools = host.ctx.tools.definitions(workerOnlyHandle.agent).map(tool => tool.name);
    assert.ok(workerOnlyTools.includes("mcp__pbot__worker_create"));
    assert.ok(workerOnlyTools.includes("mcp__pbot__worker_discover"));
    assert.equal(workerOnlyTools.includes("mcp__pbot__workspace_mcp_discover"), false);
    assert.equal(workerOnlyTools.includes("mcp__mini__ping_tool"), false);
    const workerOnlySkills = await host.ctx.skills.list({ scope: workerOnlyHandle.agent, cwd: workerOnlyWs });
    assert.equal(workerOnlySkills.some(skill => skill.provider === "pbot"), false);
    const workerOnlyPrompt = await host.ctx.systemPrompt.assemble(assembleContextFor(workerOnlyHandle.agent, signal));
    assert.equal(workerOnlyPrompt.sections.some(section => section.name === "pbot:workspace"), false);

    await extension.dispose();
    await fullHandle.dispose();
    await workerOnlyHandle.dispose();
  } finally {
    await host.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
