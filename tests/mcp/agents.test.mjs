import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const builtBundle = resolve("lib/antigravity-plugin");

// Minimal real ACP v1 stdio process for testing end-to-end MCP -> AgentService -> acp-worker -> ACP protocol.
const acpServerScript = `#!/usr/bin/env node
let buffer = "";
let turns = 0;
let pendingPerm = false;
process.stdin.setEncoding("utf8");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, sessionCapabilities: { close: {} } } } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "local-acp-session-1", configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      turns++;
      const text = (msg.params.prompt || []).filter(b => b.type === "text").map(b => b.text).join("\\n");
      if (text.includes("REQUEST_PERMISSION")) {
        pendingPerm = msg.id;
        send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: "tc-1", title: "write" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      } else {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m-" + turns, content: { type: "text", text: "TURN=" + turns + "\\n" + text } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }
    } else if (msg.id === "perm-1" && pendingPerm) {
      const promptId = pendingPerm;
      pendingPerm = false;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "local-acp-session-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m-perm", content: { type: "text", text: "PERM=" + msg.result.outcome.outcome } } } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    } else if (msg.method === "session/close") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`;

class McpClient {
  #nextId = 1;
  #pending = new Map();
  #buffer = "";
  constructor(child) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.#buffer += chunk;
      for (;;) {
        const nl = this.#buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = this.#pending.get(msg.id);
        if (resolver) {
          this.#pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
  }
  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("MCP request timeout: " + method));
      }, 20_000);
      this.#pending.set(id, response => { clearTimeout(timer); resolveResponse(response); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(args) {
    const response = await this.request("tools/call", { name: "pbot_agent", arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return {
      isError: Boolean(response.result.isError),
      text: response.result.content[0].text,
      data: response.result.isError ? undefined : JSON.parse(response.result.content[0].text),
    };
  }
  async close() {
    this.child.stdin.end();
    await new Promise(resolveExit => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolveExit(); }, 5000);
      this.child.once("close", () => { clearTimeout(timer); resolveExit(); });
    });
  }
}

test("bundled MCP server runs without node_modules and delegates to custom ACP harnesses", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-mcp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginDir = join(root, "plugin");
  const workspace = join(root, "workspace");
  const disabledWorkspace = join(root, "disabled");
  const controlDir = join(root, "subagents");
  const acpBin = join(root, "local-acp.mjs");
  await Promise.all([
    cp(builtBundle, pluginDir, { recursive: true }),
    mkdir(join(workspace, ".pbot"), { recursive: true }),
    mkdir(join(workspace, "agents"), { recursive: true }),
    mkdir(disabledWorkspace, { recursive: true }),
    writeFile(acpBin, acpServerScript, { mode: 0o755 }),
  ]);
  await writeFile(join(workspace, "agents/general-purpose.md"), "CUSTOM_EXPERT_RULE\n");
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    acp: {
      "local-acp": { command: process.execPath, args: [acpBin] },
    },
  }));

  const child = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(() => mcp.close());

  const init = await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  assert.equal(init.result.serverInfo.name, "personal-bot");
  const tools = await mcp.request("tools/list");
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ["pbot_agent"]);

  const rejected = await mcp.call({ action: "backends", workspace: disabledWorkspace });
  assert.equal(rejected.isError, true);

  const backends = await mcp.call({ action: "backends", workspace });
  assert.equal(backends.isError, false, backends.text);
  const names = backends.data.backends.map(item => item.backend);
  for (const required of ["pi", "dsh", "claude", "antigravity", "codex", "local-acp"]) assert.ok(names.includes(required));
  assert.equal(backends.data.backends.find(item => item.backend === "local-acp").available, true);

  // First turn: ACP backend without systemPrompt capability gets workspace context prepended once.
  const started = await mcp.call({
    action: "start",
    workspace,
    backend: "local-acp",
    name: "coder",
    message: "Implement feature A",
    waitMs: 15_000,
  });
  assert.equal(started.isError, false, started.text);
  assert.equal(started.data.settled, true);
  assert.equal(started.data.cycle.state, "completed");
  assert.ok(started.data.report.includes("TURN=1"));
  assert.ok(started.data.report.includes("CUSTOM_EXPERT_RULE"));
  assert.ok(started.data.report.includes("Implement feature A"));

  // Second turn: followUp does not re-inject workspace context.
  const agentId = started.data.agentId;
  const sent = await mcp.call({ action: "send", workspace, agentId, message: "Follow up task", delivery: "followUp" });
  assert.equal(sent.isError, false, sent.text);
  const waited = await mcp.call({ action: "wait", workspace, agentId, timeoutMs: 15_000 });
  assert.equal(waited.isError, false, waited.text);
  assert.equal(waited.data.settled, true);
  assert.ok(waited.data.report.includes("TURN=2"));
  assert.ok(waited.data.report.includes("Follow up task"));
  assert.equal(waited.data.report.includes("CUSTOM_EXPERT_RULE"), false);

  // Non-interactive permission request fails fast with cancelled rather than hanging.
  await mcp.call({ action: "send", workspace, agentId, message: "REQUEST_PERMISSION", delivery: "followUp" });
  const perm = await mcp.call({ action: "wait", workspace, agentId, timeoutMs: 15_000 });
  assert.equal(perm.data.settled, true);
  assert.ok(perm.data.report.includes("PERM=cancelled"));

  const listed = await mcp.call({ action: "list", workspace });
  assert.equal(listed.data.agents.length, 1);
  const stopped = await mcp.call({ action: "stop", workspace, agentId });
  assert.equal(stopped.isError, false);
});
