import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const builtBundle = resolve("lib/antigravity-plugin");

// Minimal real ACP v1 stdio process advertising models/thinking, permissions, optional resume, delays, and long reports.
const acpServerScript = `#!/usr/bin/env node
let buffer = "";
let turns = 0;
let pendingPerm = false;
let currentModel = "acme-sonnet-4-5";
let currentThinking = "medium";
const supportsResume = process.env.TEST_SUPPORTS_RESUME === "1";
const configOptions = () => [
  {
    id: "model",
    category: "model",
    type: "select",
    name: "Model",
    currentValue: currentModel,
    options: [
      { value: "acme-sonnet-4-5", name: "Sonnet 4.5" },
      { value: "acme-opus-4-5", name: "Opus 4.5" },
    ],
  },
  {
    id: "thought_level",
    category: "thought_level",
    type: "select",
    name: "Thinking",
    currentValue: currentThinking,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra High" },
    ],
  },
];
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
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false },
            sessionCapabilities: { close: {}, ...(supportsResume ? { resume: {} } : {}) },
          },
        },
      });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "local-acp-session-1", configOptions: configOptions() } });
    } else if (msg.method === "session/resume" && supportsResume) {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptions() } });
    } else if (msg.method === "session/set_config_option") {
      if (msg.params.configId === "model") currentModel = msg.params.value;
      if (msg.params.configId === "thought_level") currentThinking = msg.params.value;
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptions() } });
    } else if (msg.method === "session/prompt") {
      turns++;
      const text = (msg.params.prompt || []).filter(b => b.type === "text").map(b => b.text).join("\\n");
      const delayMatch = text.match(/DELAY:(\\d+)/);
      const replyTurn = () => {
        if (text.includes("REQUEST_PERMISSION")) {
          pendingPerm = msg.id;
          send({
            jsonrpc: "2.0",
            id: "perm-" + turns,
            method: "session/request_permission",
            params: {
              sessionId: msg.params.sessionId,
              toolCall: { toolCallId: "tc-" + turns, title: "Edit src/app.ts", kind: "edit" },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "reject", name: "Reject once", kind: "reject_once" },
              ],
            },
          });
          return;
        }
        const body = text.includes("LONG_REPORT")
          ? "LONG_START:" + "X".repeat(17_000) + ":LONG_END"
          : "TURN=" + turns + " MODEL=" + currentModel + " THINKING=" + currentThinking + " ENV=" + (process.env.TEST_HARNESS_TAG || "") + "\\n" + text;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "m-" + turns,
              content: { type: "text", text: body },
            },
          },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      };
      if (delayMatch) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "tool_call", name: "slow_work" },
          },
        });
        setTimeout(replyTurn, Number(delayMatch[1]));
      } else {
        replyTurn();
      }
    } else if (typeof msg.id === "string" && msg.id.startsWith("perm-") && pendingPerm) {
      const promptId = pendingPerm;
      pendingPerm = false;
      const outcome = msg.result.outcome;
      const summary = outcome.outcome === "selected" ? "selected:" + outcome.optionId : outcome.outcome;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "local-acp-session-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m-perm-" + turns, content: { type: "text", text: "PERM=" + summary } } } });
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
  notifications = [];
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
        if (msg.id === undefined) {
          this.notifications.push(msg);
          continue;
        }
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
      }, 25_000);
      this.#pending.set(id, response => { clearTimeout(timer); resolveResponse(response); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(args, meta) {
    const response = await this.request("tools/call", {
      name: "pbot_worker",
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    });
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

test("bundled MCP server exposes streamlined pbot_worker with sync defaults, auto-resume, permissions, pagination, and parallel calls", async t => {
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
      "local-acp": { command: process.execPath, args: [acpBin], env: { TEST_HARNESS_TAG: "OK" } },
      "local-resume": { command: process.execPath, args: [acpBin], env: { TEST_HARNESS_TAG: "RESUMABLE", TEST_SUPPORTS_RESUME: "1" } },
      "local-allow": { command: process.execPath, args: [acpBin], permission: "allow" },
      "local-deny": { command: process.execPath, args: [acpBin], permission: "deny" },
    },
  }));

  const child = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir, PBOT_WORKSPACE_ROOT: workspace },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(() => mcp.close());

  const init = await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  assert.equal(init.result.serverInfo.name, "personal-bot");
  assert.equal(typeof init.result.instructions, "string");
  assert.ok(init.result.instructions.length > 0);

  const tools = await mcp.request("tools/list");
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ["pbot_worker"]);
  const tool = tools.result.tools[0];
  const schema = tool.inputSchema;
  assert.deepEqual(schema.properties.action.enum, ["start", "send", "wait", "permission", "read", "status", "stop", "backends", "models"]);
  assert.deepEqual(Object.keys(schema.properties), [
    "action", "backend", "message", "model", "thinking", "workerId",
    "decision", "waitMs", "cwd", "permissionId", "offset", "workspace",
  ]);
  for (const removed of ["delivery", "timeoutMs", "provider", "name", "files", "requestId", "cycleId", "limit"]) {
    assert.equal(Object.hasOwn(schema.properties, removed), false);
  }
  assert.ok(tool.description.includes("local-acp"));
  assert.ok(schema.properties.backend.description.includes("local-acp"));

  // Unknown parameter fails fast instead of being silently ignored.
  const unknownParam = await mcp.call({ action: "backends", workspace, timeoutMs: 1000 });
  assert.equal(unknownParam.isError, true);
  assert.ok(unknownParam.text.includes("timeoutMs"));

  // Disabled workspace is rejected.
  const rejected = await mcp.call({ action: "backends", workspace: disabledWorkspace });
  assert.equal(rejected.isError, true);

  const backends = await mcp.call({ action: "backends", workspace });
  assert.equal(backends.isError, false, backends.text);
  const names = backends.data.backends.map(item => item.backend);
  for (const required of ["pi", "dsh", "claude", "antigravity", "codex", "local-acp", "local-resume"]) assert.ok(names.includes(required));
  const localBackend = backends.data.backends.find(item => item.backend === "local-acp");
  assert.equal(localBackend.available, true);
  assert.equal(localBackend.permission, "ask");
  assert.equal(backends.data.backends.find(item => item.backend === "local-allow").permission, "allow");

  // Discover models and thinking choices without starting a persistent worker.
  const models = await mcp.call({ action: "models", workspace, backend: "local-acp" });
  assert.equal(models.isError, false, models.text);
  assert.equal(models.data.backend, "local-acp");
  assert.deepEqual(models.data.models.map(item => item.value), ["acme-sonnet-4-5", "acme-opus-4-5"]);
  assert.deepEqual(models.data.thinking.map(item => item.value), ["low", "medium", "high", "xhigh"]);
  assert.equal(models.data.currentModel, "acme-sonnet-4-5");
  assert.equal(models.data.currentThinking, "medium");

  // Missing message or backend fails clearly on start.
  const missingMessage = await mcp.call({ action: "start", workspace, backend: "local-acp" });
  assert.equal(missingMessage.isError, true);
  const missingBackend = await mcp.call({ action: "start", workspace, message: "No host configured" });
  assert.equal(missingBackend.isError, true);

  // Invalid model fails synchronously on start even when waitMs is 0, listing valid options.
  const invalidStart = await mcp.call({
    action: "start",
    workspace,
    backend: "local-acp",
    model: "does-not-exist",
    message: "Should fail before running",
    waitMs: 0,
  });
  assert.equal(invalidStart.isError, true);
  assert.ok(invalidStart.text.includes("acme-opus-4-5"));

  // First turn: start waits synchronously by default (no waitMs needed!), lenient model/thinking match works, payload is trimmed.
  const started = await mcp.call({
    action: "start",
    workspace,
    backend: "local-acp",
    model: "Opus 4.5",
    thinking: "HIGH",
    message: "Implement feature A",
  });
  assert.equal(started.isError, false, started.text);
  assert.equal(started.data.settled, true);
  assert.deepEqual(started.data.selection, { model: "acme-opus-4-5", thinking: "high" });
  assert.deepEqual(started.data.cycle, { state: "completed" });
  for (const trimmed of ["name", "requestId", "cycles", "nextOffset", "totalLength", "release", "parentSessionId", "transport"]) {
    assert.equal(Object.hasOwn(started.data, trimmed), false, trimmed);
  }
  await assert.rejects(access(join(controlDir, started.data.workerId, "acp-options.json")));
  assert.ok(started.data.report.includes("TURN=1 MODEL=acme-opus-4-5 THINKING=high ENV=OK"));
  assert.ok(started.data.report.includes("CUSTOM_EXPERT_RULE"));
  assert.ok(started.data.report.includes("Implement feature A"));

  // Second turn: send also waits synchronously by default and does not re-inject workspace context.
  const workerId = started.data.workerId;
  const second = await mcp.call({ action: "send", workspace, workerId, message: "Follow up task" });
  assert.equal(second.isError, false, second.text);
  assert.equal(second.data.settled, true);
  assert.ok(second.data.report.includes("TURN=2"));
  assert.ok(second.data.report.includes("Follow up task"));
  assert.equal(second.data.report.includes("CUSTOM_EXPERT_RULE"), false);

  // Default permission policy ("ask") forwards requests; permission requires decision and waits by default.
  const needAllow = await mcp.call({ action: "send", workspace, workerId, message: "REQUEST_PERMISSION" });
  assert.equal(needAllow.isError, false, needAllow.text);
  assert.equal(needAllow.data.settled, false);
  assert.equal(needAllow.data.needsPermission, true);
  assert.equal(needAllow.data.pendingPermissions.length, 1);
  assert.ok(needAllow.data.pendingPermissions[0].description.includes("Edit src/app.ts"));
  const missingDecision = await mcp.call({ action: "permission", workspace, workerId });
  assert.equal(missingDecision.isError, true);
  const approved = await mcp.call({
    action: "permission",
    workspace,
    workerId,
    permissionId: needAllow.data.pendingPermissions[0].permissionId,
    decision: "allow",
  });
  assert.equal(approved.isError, false, approved.text);
  assert.equal(approved.data.settled, true);
  assert.ok(approved.data.report.includes("PERM=selected:allow"));

  // Omitting permissionId resolves the single pending request; denying selects reject_once.
  const needDeny = await mcp.call({ action: "send", workspace, workerId, message: "REQUEST_PERMISSION" });
  assert.equal(needDeny.data.needsPermission, true);
  const denied = await mcp.call({ action: "permission", workspace, workerId, decision: "deny" });
  assert.equal(denied.isError, false, denied.text);
  assert.equal(denied.data.settled, true);
  assert.ok(denied.data.report.includes("PERM=selected:reject"));

  // Long report returns nextOffset and paginates cleanly with read + offset.
  const longTurn = await mcp.call({ action: "send", workspace, workerId, message: "LONG_REPORT" });
  assert.equal(longTurn.isError, false, longTurn.text);
  assert.equal(longTurn.data.settled, true);
  assert.equal(longTurn.data.nextOffset, 16_000);
  assert.ok(longTurn.data.totalLength > 17_000);
  const page2 = await mcp.call({ action: "read", workspace, workerId, offset: longTurn.data.nextOffset });
  assert.equal(page2.isError, false, page2.text);
  assert.equal(Object.hasOwn(page2.data, "nextOffset"), false);
  assert.ok((longTurn.data.report + page2.data.report).includes(":LONG_END"));

  // Workspace-configured permission: "allow" and "deny" settle without interrupting the parent session.
  const autoAllow = await mcp.call({ action: "start", workspace, backend: "local-allow", message: "REQUEST_PERMISSION" });
  assert.equal(autoAllow.isError, false, autoAllow.text);
  assert.equal(autoAllow.data.settled, true);
  assert.ok(autoAllow.data.report.includes("PERM=selected:allow"));
  assert.equal(autoAllow.data.selection.model, "acme-sonnet-4-5");
  assert.equal(autoAllow.data.selection.thinking, "medium");

  const autoDeny = await mcp.call({ action: "start", workspace, backend: "local-deny", message: "REQUEST_PERMISSION" });
  assert.equal(autoDeny.isError, false, autoDeny.text);
  assert.equal(autoDeny.data.settled, true);
  assert.ok(autoDeny.data.report.includes("PERM=selected:reject"));

  // status without workerId lists all workers; with workerId inspects one worker.
  const allStatus = await mcp.call({ action: "status", workspace });
  assert.equal(allStatus.isError, false, allStatus.text);
  assert.ok(allStatus.data.workers.some(item => item.workerId === workerId));
  const oneStatus = await mcp.call({ action: "status", workspace, workerId });
  assert.equal(oneStatus.isError, false, oneStatus.text);
  assert.equal(oneStatus.data.workerId, workerId);
  assert.equal(oneStatus.data.cycle.state, "completed");

  // Async start (waitMs: 0) + wait timeout + progress notifications + wait completion.
  const asyncStart = await mcp.call({ action: "start", workspace, backend: "local-acp", message: "DELAY:600 Async work", waitMs: 0 });
  assert.equal(asyncStart.isError, false, asyncStart.text);
  assert.equal(Object.hasOwn(asyncStart.data, "report"), false);
  const shortWait = await mcp.call({ action: "wait", workspace, workerId: asyncStart.data.workerId, waitMs: 100 }, { progressToken: "tok-wait" });
  assert.equal(shortWait.isError, false, shortWait.text);
  if (shortWait.data.timedOut) {
    const finished = await mcp.call({ action: "wait", workspace, workerId: asyncStart.data.workerId }, { progressToken: "tok-wait" });
    assert.equal(finished.isError, false, finished.text);
    assert.equal(finished.data.settled, true);
    assert.ok(finished.data.report.includes("Async work"));
  } else {
    assert.equal(shortWait.data.settled, true);
    assert.ok(shortWait.data.report.includes("Async work"));
  }
  assert.ok(mcp.notifications.some(n => n.method === "notifications/progress" && n.params.progressToken === "tok-wait"));

  // Concurrent parallel start calls over the same stdio MCP server execute concurrently.
  const [parA, parB] = await Promise.all([
    mcp.call({ action: "start", workspace, backend: "local-acp", message: "DELAY:300 Parallel A" }),
    mcp.call({ action: "start", workspace, backend: "local-acp", message: "DELAY:300 Parallel B" }),
  ]);
  assert.equal(parA.data.settled, true);
  assert.equal(parB.data.settled, true);
  assert.ok(parA.data.report.includes("Parallel A"));
  assert.ok(parB.data.report.includes("Parallel B"));

  // send on a stopped resumable worker automatically resumes it.
  const resumable = await mcp.call({ action: "start", workspace, backend: "local-resume", message: "Before stop" });
  assert.equal(resumable.data.settled, true);
  await mcp.call({ action: "stop", workspace, workerId: resumable.data.workerId });
  for (let i = 0; i < 50; i++) {
    const check = await mcp.call({ action: "status", workspace, workerId: resumable.data.workerId });
    if (!check.data.alive) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const autoResumed = await mcp.call({ action: "send", workspace, workerId: resumable.data.workerId, message: "After stop" });
  assert.equal(autoResumed.isError, false, autoResumed.text);
  assert.equal(autoResumed.data.settled, true);
  assert.ok(autoResumed.data.report.includes("After stop"));
  assert.equal(autoResumed.data.report.includes("CUSTOM_EXPERT_RULE"), false);

  for (const id of [workerId, autoAllow.data.workerId, autoDeny.data.workerId, asyncStart.data.workerId, parA.data.workerId, parB.data.workerId, resumable.data.workerId]) {
    const stopped = await mcp.call({ action: "stop", workspace, workerId: id });
    assert.equal(stopped.isError, false);
  }

  // When PBOT_HOST is provided, omitting backend defaults to the current host for both models and start.
  const hostedChild = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir, PBOT_WORKSPACE_ROOT: workspace, PBOT_HOST: "local-acp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const hosted = new McpClient(hostedChild);
  t.after(() => hosted.close());
  await hosted.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  const defaultModels = await hosted.call({ action: "models", workspace });
  assert.equal(defaultModels.isError, false, defaultModels.text);
  assert.equal(defaultModels.data.backend, "local-acp");
  const defaultStarted = await hosted.call({ action: "start", workspace, message: "Default host run" });
  assert.equal(defaultStarted.isError, false, defaultStarted.text);
  assert.equal(defaultStarted.data.backend, "local-acp");
  assert.equal(defaultStarted.data.settled, true);
  assert.ok(defaultStarted.data.report.includes("Default host run"));
  await hosted.call({ action: "stop", workspace, workerId: defaultStarted.data.workerId });
});
