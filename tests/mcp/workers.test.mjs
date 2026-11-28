import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const builtBundle = resolve("lib/antigravity-plugin");

// Minimal real ACP v1 stdio process advertising models/thinking, permissions, form/url elicitations, optional resume, delays, and long reports.
const acpServerScript = `#!/usr/bin/env node
let buffer = "";
let turns = 0;
let pendingPerm = false;
let pendingElicit = null;
let clientCaps = {};
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
      clientCaps = msg.params?.clientCapabilities || {};
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
                { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
                { optionId: "reject", name: "Reject once", kind: "reject_once" },
              ],
            },
          });
          return;
        }
        if (text.includes("REQUEST_FORM")) {
          if (!clientCaps?.elicitation?.form) {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m-noform-" + turns, content: { type: "text", text: "NO_FORM_CAP" } } } });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            return;
          }
          pendingElicit = { promptId: msg.id, mode: "form" };
          send({
            jsonrpc: "2.0",
            id: "elicit-" + turns,
            method: "elicitation/create",
            params: {
              sessionId: msg.params.sessionId,
              mode: "form",
              message: "请选择实现方案",
              requestedSchema: {
                type: "object",
                properties: {
                  question_0: {
                    type: "string",
                    title: "实现方案",
                    oneOf: [
                      { const: "Plan A", title: "Plan A" },
                      { const: "Plan B", title: "Plan B" },
                    ],
                  },
                  question_0_custom: { type: "string", title: "补充说明" },
                },
              },
            },
          });
          return;
        }
        if (text.includes("REQUEST_URL")) {
          if (!clientCaps?.elicitation?.url) {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m-nourl-" + turns, content: { type: "text", text: "NO_URL_CAP" } } } });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            return;
          }
          pendingElicit = { promptId: msg.id, mode: "url" };
          send({
            jsonrpc: "2.0",
            id: "elicit-" + turns,
            method: "elicitation/create",
            params: {
              sessionId: msg.params.sessionId,
              mode: "url",
              message: "请在浏览器完成授权确认",
              url: "https://example.test/auth",
              elicitationId: "url-auth-1",
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
    } else if (typeof msg.id === "string" && msg.id.startsWith("elicit-") && pendingElicit) {
      const { promptId, mode } = pendingElicit;
      pendingElicit = null;
      const prefix = mode === "url" ? "ELICIT_URL=" : "ELICIT=";
      const summary = msg.result.action + (msg.result.content ? ":" + JSON.stringify(msg.result.content) : "");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "local-acp-session-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m-elicit-" + turns, content: { type: "text", text: prefix + summary } } } });
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
  async call(name, args = {}, meta) {
    const response = await this.request("tools/call", {
      name,
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

test("bundled MCP server exposes 6 split worker_* tools with strict schemas, annotations, elicitation, permissions, pagination, and parallel calls", async t => {
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

  const listed = await mcp.request("tools/list");
  const tools = Object.fromEntries(listed.result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools), [
    "worker_create",
    "worker_close",
    "worker_request",
    "worker_response",
    "worker_output",
    "worker_discover",
    "workspace_mcp_discover",
    "workspace_mcp_call",
    "history_search",
    "history_read",
  ]);

  // Verify strict per-tool schemas and read/write MCP annotations.
  assert.deepEqual(tools.worker_create.inputSchema.required, ["backend"]);
  assert.deepEqual(Object.keys(tools.worker_create.inputSchema.properties), ["backend", "model", "thinking", "cwd", "workspace"]);
  assert.equal(tools.worker_create.annotations.readOnlyHint, false);
  assert.equal(tools.worker_create.annotations.destructiveHint, false);
  assert.ok(tools.worker_create.description.includes("local-acp"));

  assert.deepEqual(tools.worker_close.inputSchema.required, ["workerId"]);
  assert.equal(tools.worker_close.annotations.readOnlyHint, false);
  assert.equal(tools.worker_close.annotations.destructiveHint, true);

  assert.deepEqual(tools.worker_request.inputSchema.required, ["workerId", "message"]);
  assert.deepEqual(Object.keys(tools.worker_request.inputSchema.properties), ["workerId", "message", "waitMs", "workspace"]);
  assert.equal(tools.worker_request.annotations.readOnlyHint, false);

  assert.deepEqual(tools.worker_response.inputSchema.required, ["workerId", "action"]);
  assert.deepEqual(tools.worker_response.inputSchema.properties.action.enum, ["accept", "decline", "cancel"]);
  assert.deepEqual(Object.keys(tools.worker_response.inputSchema.properties), ["workerId", "action", "requestId", "optionId", "content", "waitMs", "workspace"]);
  assert.equal(tools.worker_response.annotations.readOnlyHint, false);

  assert.deepEqual(tools.worker_output.inputSchema.required, ["workerId"]);
  assert.deepEqual(Object.keys(tools.worker_output.inputSchema.properties), ["workerId", "offset", "waitMs", "workspace"]);
  assert.equal(tools.worker_output.annotations.readOnlyHint, true);

  assert.deepEqual(tools.worker_discover.inputSchema.required, []);
  assert.deepEqual(tools.worker_discover.inputSchema.properties.target.enum, ["overview", "workers", "backends", "models"]);
  assert.equal(tools.worker_discover.annotations.readOnlyHint, true);

  assert.deepEqual(tools.workspace_mcp_discover.inputSchema.required, []);
  assert.deepEqual(Object.keys(tools.workspace_mcp_discover.inputSchema.properties), ["server", "workspace"]);
  assert.equal(tools.workspace_mcp_discover.annotations.readOnlyHint, true);

  assert.deepEqual(tools.workspace_mcp_call.inputSchema.required, ["server", "tool"]);
  assert.deepEqual(Object.keys(tools.workspace_mcp_call.inputSchema.properties), ["server", "tool", "arguments", "workspace"]);
  assert.equal(tools.workspace_mcp_call.annotations.readOnlyHint, false);

  // Legacy monolithic tool name and per-tool unknown/cross-target parameters fail fast.
  const legacyCall = await mcp.call("pbot_worker", { action: "status", workspace });
  assert.equal(legacyCall.isError, true);
  const badCreateParam = await mcp.call("worker_create", { workspace, backend: "local-acp", message: "No message on create" });
  assert.equal(badCreateParam.isError, true);
  assert.ok(badCreateParam.text.includes("message"));
  const badDiscoverCombo1 = await mcp.call("worker_discover", { workspace, target: "backends", workerId: "w1" });
  assert.equal(badDiscoverCombo1.isError, true);
  const badDiscoverCombo2 = await mcp.call("worker_discover", { workspace, target: "overview", backend: "local-acp" });
  assert.equal(badDiscoverCombo2.isError, true);

  // Disabled workspace is rejected.
  const rejected = await mcp.call("worker_discover", { workspace: disabledWorkspace });
  assert.equal(rejected.isError, true);

  // worker_discover default ("overview") returns local backends and workers without probing models.
  const overview = await mcp.call("worker_discover", { workspace });
  assert.equal(overview.isError, false, overview.text);
  assert.equal(overview.data.target, "overview");
  assert.deepEqual(overview.data.workers, []);
  assert.ok(overview.data.backends.some(item => item.backend === "local-acp" && item.available && item.permission === "ask"));
  assert.equal(overview.data.backends.find(item => item.backend === "local-allow").permission, "allow");

  // worker_discover target="backends" lists built-in + custom backends.
  const backends = await mcp.call("worker_discover", { workspace, target: "backends" });
  assert.equal(backends.isError, false, backends.text);
  assert.equal(backends.data.target, "backends");
  const names = backends.data.backends.map(item => item.backend);
  for (const required of ["pi", "dsh", "claude", "antigravity", "codex", "qoder", "local-acp", "local-resume"]) assert.ok(names.includes(required));

  // worker_discover target="models" probes models and thinking without creating a persistent worker.
  const models = await mcp.call("worker_discover", { workspace, target: "models", backend: "local-acp" });
  assert.equal(models.isError, false, models.text);
  assert.equal(models.data.target, "models");
  assert.equal(models.data.backend, "local-acp");
  assert.deepEqual(models.data.models.map(item => item.value), ["acme-sonnet-4-5", "acme-opus-4-5"]);
  assert.deepEqual(models.data.thinking.map(item => item.value), ["low", "medium", "high", "xhigh"]);
  assert.equal(models.data.currentModel, "acme-sonnet-4-5");
  assert.equal(models.data.currentThinking, "medium");

  // worker_create requires backend explicitly and fails synchronously on invalid model.
  const missingBackend = await mcp.call("worker_create", { workspace });
  assert.equal(missingBackend.isError, true);
  const invalidCreate = await mcp.call("worker_create", { workspace, backend: "local-acp", model: "does-not-exist" });
  assert.equal(invalidCreate.isError, true);
  assert.ok(invalidCreate.text.includes("acme-opus-4-5"));

  // worker_create creates an idle worker with configured model/thinking and capabilities (no message sent yet).
  const created = await mcp.call("worker_create", {
    workspace,
    backend: "local-acp",
    model: "Opus 4.5",
    thinking: "HIGH",
  });
  assert.equal(created.isError, false, created.text);
  assert.equal(created.data.state, "idle");
  assert.equal(created.data.alive, true);
  assert.deepEqual(created.data.selection, { model: "acme-opus-4-5", thinking: "high" });
  assert.deepEqual(created.data.capabilities, { resume: false });
  assert.equal(Object.hasOwn(created.data, "report"), false);
  const workerId = created.data.workerId;
  await assert.rejects(access(join(controlDir, workerId, "acp-options.json")));

  // worker_request rejects unrelated params like model.
  const badRequestParam = await mcp.call("worker_request", { workspace, workerId, message: "Hi", model: "sonnet" });
  assert.equal(badRequestParam.isError, true);

  // First worker_request injects workspace context once and waits synchronously by default.
  const first = await mcp.call("worker_request", { workspace, workerId, message: "Implement feature A" });
  assert.equal(first.isError, false, first.text);
  assert.equal(first.data.settled, true);
  assert.deepEqual(first.data.selection, { model: "acme-opus-4-5", thinking: "high" });
  assert.deepEqual(first.data.cycle, { state: "completed" });
  for (const trimmed of ["name", "requestId", "cycles", "nextOffset", "totalLength", "release", "parentSessionId", "transport"]) {
    assert.equal(Object.hasOwn(first.data, trimmed), false, trimmed);
  }
  assert.ok(first.data.report.includes("TURN=1 MODEL=acme-opus-4-5 THINKING=high ENV=OK"));
  assert.ok(first.data.report.includes("CUSTOM_EXPERT_RULE"));
  assert.ok(first.data.report.includes("Implement feature A"));

  // Follow-up worker_request does not re-inject workspace context.
  const second = await mcp.call("worker_request", { workspace, workerId, message: "Follow up task" });
  assert.equal(second.isError, false, second.text);
  assert.equal(second.data.settled, true);
  assert.ok(second.data.report.includes("TURN=2"));
  assert.ok(second.data.report.includes("Follow up task"));
  assert.equal(second.data.report.includes("CUSTOM_EXPERT_RULE"), false);

  // Permission request: unified needsResponse + pendingRequests[kind="permission"] -> worker_response.
  const needAllow = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_PERMISSION" });
  assert.equal(needAllow.isError, false, needAllow.text);
  assert.equal(needAllow.data.settled, false);
  assert.equal(needAllow.data.needsResponse, true);
  assert.equal(needAllow.data.pendingRequests.length, 1);
  assert.equal(needAllow.data.pendingRequests[0].kind, "permission");
  assert.ok(needAllow.data.pendingRequests[0].description.includes("Edit src/app.ts"));
  // Validation rejects content on permission and conflicting optionId.
  const wrongContent = await mcp.call("worker_response", { workspace, workerId, action: "accept", content: { a: "1" } });
  assert.equal(wrongContent.isError, true);
  const wrongOption = await mcp.call("worker_response", { workspace, workerId, action: "accept", optionId: "reject" });
  assert.equal(wrongOption.isError, true);
  const approvedAlways = await mcp.call("worker_response", {
    workspace,
    workerId,
    requestId: needAllow.data.pendingRequests[0].requestId,
    action: "accept",
    optionId: "allow-always",
  });
  assert.equal(approvedAlways.isError, false, approvedAlways.text);
  assert.equal(approvedAlways.data.settled, true);
  assert.ok(approvedAlways.data.report.includes("PERM=selected:allow-always"));

  // Default accept / decline / cancel without optionId.
  const needDeny = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_PERMISSION" });
  assert.equal(needDeny.data.needsResponse, true);
  const denied = await mcp.call("worker_response", { workspace, workerId, action: "decline" });
  assert.equal(denied.isError, false, denied.text);
  assert.equal(denied.data.settled, true);
  assert.ok(denied.data.report.includes("PERM=selected:reject"));

  const needCancel = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_PERMISSION" });
  assert.equal(needCancel.data.needsResponse, true);
  const cancelled = await mcp.call("worker_response", { workspace, workerId, action: "cancel" });
  assert.equal(cancelled.isError, false, cancelled.text);
  assert.equal(cancelled.data.settled, true);
  assert.ok(cancelled.data.report.includes("PERM=cancelled"));

  // ACP elicitation/create (mode="form", AskUserQuestion-style) -> needsResponse + pendingRequests[kind="form"] -> worker_response.
  const needForm = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_FORM" });
  assert.equal(needForm.isError, false, needForm.text);
  assert.equal(needForm.data.settled, false);
  assert.equal(needForm.data.needsResponse, true);
  assert.equal(needForm.data.pendingRequests.length, 1);
  assert.equal(needForm.data.pendingRequests[0].kind, "form");
  assert.equal(needForm.data.pendingRequests[0].message, "请选择实现方案");
  assert.ok(needForm.data.pendingRequests[0].schema.properties.question_0);
  // Validation rejects optionId on form elicitation and content on decline.
  assert.equal((await mcp.call("worker_response", { workspace, workerId, action: "accept", optionId: "allow" })).isError, true);
  assert.equal((await mcp.call("worker_response", { workspace, workerId, action: "decline", content: { question_0: "Plan A" } })).isError, true);
  const answeredForm = await mcp.call("worker_response", {
    workspace,
    workerId,
    requestId: needForm.data.pendingRequests[0].requestId,
    action: "accept",
    content: { question_0: "Plan B", question_0_custom: "Port 8080" },
  });
  assert.equal(answeredForm.isError, false, answeredForm.text);
  assert.equal(answeredForm.data.settled, true);
  assert.ok(answeredForm.data.report.includes('ELICIT=accept:{"question_0":"Plan B","question_0_custom":"Port 8080"}'));

  // Form elicitation declined.
  const needFormDecline = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_FORM" });
  assert.equal(needFormDecline.data.needsResponse, true);
  const declinedForm = await mcp.call("worker_response", { workspace, workerId, action: "decline" });
  assert.equal(declinedForm.isError, false, declinedForm.text);
  assert.equal(declinedForm.data.settled, true);
  assert.ok(declinedForm.data.report.includes("ELICIT=decline"));

  // ACP elicitation/create (mode="url") -> needsResponse + pendingRequests[kind="url"] -> worker_response.
  const needUrl = await mcp.call("worker_request", { workspace, workerId, message: "REQUEST_URL" });
  assert.equal(needUrl.isError, false, needUrl.text);
  assert.equal(needUrl.data.settled, false);
  assert.equal(needUrl.data.needsResponse, true);
  assert.equal(needUrl.data.pendingRequests[0].kind, "url");
  assert.equal(needUrl.data.pendingRequests[0].url, "https://example.test/auth");
  assert.equal((await mcp.call("worker_response", { workspace, workerId, action: "accept", content: { ok: true } })).isError, true);
  const acceptedUrl = await mcp.call("worker_response", { workspace, workerId, action: "accept" });
  assert.equal(acceptedUrl.isError, false, acceptedUrl.text);
  assert.equal(acceptedUrl.data.settled, true);
  assert.ok(acceptedUrl.data.report.includes("ELICIT_URL=accept"));

  // Long report returns nextOffset and paginates immediately via worker_output + offset.
  const longTurn = await mcp.call("worker_request", { workspace, workerId, message: "LONG_REPORT" });
  assert.equal(longTurn.isError, false, longTurn.text);
  assert.equal(longTurn.data.settled, true);
  assert.equal(longTurn.data.nextOffset, 16_000);
  assert.ok(longTurn.data.totalLength > 17_000);
  const page2 = await mcp.call("worker_output", { workspace, workerId, offset: longTurn.data.nextOffset });
  assert.equal(page2.isError, false, page2.text);
  assert.equal(page2.data.settled, true);
  assert.equal(Object.hasOwn(page2.data, "nextOffset"), false);
  assert.ok((longTurn.data.report + page2.data.report).includes(":LONG_END"));

  // Workspace-configured permission: "allow" and "deny" settle without interrupting the parent session.
  const allowWorker = await mcp.call("worker_create", { workspace, backend: "local-allow" });
  assert.equal(allowWorker.isError, false, allowWorker.text);
  assert.equal(allowWorker.data.selection.model, "acme-sonnet-4-5");
  assert.equal(allowWorker.data.selection.thinking, "medium");
  const autoAllow = await mcp.call("worker_request", { workspace, workerId: allowWorker.data.workerId, message: "REQUEST_PERMISSION" });
  assert.equal(autoAllow.isError, false, autoAllow.text);
  assert.equal(autoAllow.data.settled, true);
  assert.ok(autoAllow.data.report.includes("PERM=selected:allow"));

  const denyWorker = await mcp.call("worker_create", { workspace, backend: "local-deny" });
  const autoDeny = await mcp.call("worker_request", { workspace, workerId: denyWorker.data.workerId, message: "REQUEST_PERMISSION" });
  assert.equal(autoDeny.isError, false, autoDeny.text);
  assert.equal(autoDeny.data.settled, true);
  assert.ok(autoDeny.data.report.includes("PERM=selected:reject"));

  // worker_discover target="workers" returns all or single worker uniformly in workers[].
  const allWorkers = await mcp.call("worker_discover", { workspace, target: "workers" });
  assert.equal(allWorkers.isError, false, allWorkers.text);
  assert.equal(allWorkers.data.target, "workers");
  assert.ok(allWorkers.data.workers.some(item => item.workerId === workerId));
  const oneWorker = await mcp.call("worker_discover", { workspace, target: "workers", workerId });
  assert.equal(oneWorker.isError, false, oneWorker.text);
  assert.equal(oneWorker.data.workers.length, 1);
  assert.equal(oneWorker.data.workers[0].workerId, workerId);
  assert.equal(oneWorker.data.workers[0].cycle.state, "completed");

  // Async worker_request (waitMs: 0) + worker_output timeout + progress notifications + completion.
  const asyncWorker = await mcp.call("worker_create", { workspace, backend: "local-acp" });
  const asyncReq = await mcp.call("worker_request", { workspace, workerId: asyncWorker.data.workerId, message: "DELAY:600 Async work", waitMs: 0 });
  assert.equal(asyncReq.isError, false, asyncReq.text);
  assert.equal(Object.hasOwn(asyncReq.data, "report"), false);
  const shortWait = await mcp.call("worker_output", { workspace, workerId: asyncWorker.data.workerId, waitMs: 100 }, { progressToken: "tok-wait" });
  assert.equal(shortWait.isError, false, shortWait.text);
  if (shortWait.data.timedOut) {
    const finished = await mcp.call("worker_output", { workspace, workerId: asyncWorker.data.workerId }, { progressToken: "tok-wait" });
    assert.equal(finished.isError, false, finished.text);
    assert.equal(finished.data.settled, true);
    assert.ok(finished.data.report.includes("Async work"));
  } else {
    assert.equal(shortWait.data.settled, true);
    assert.ok(shortWait.data.report.includes("Async work"));
  }
  assert.ok(mcp.notifications.some(n => n.method === "notifications/progress" && n.params.progressToken === "tok-wait"));

  // Parallel create + parallel request execute concurrently over the same stdio MCP server.
  const [parWorkerA, parWorkerB] = await Promise.all([
    mcp.call("worker_create", { workspace, backend: "local-acp" }),
    mcp.call("worker_create", { workspace, backend: "local-acp" }),
  ]);
  const [parA, parB] = await Promise.all([
    mcp.call("worker_request", { workspace, workerId: parWorkerA.data.workerId, message: "DELAY:300 Parallel A" }),
    mcp.call("worker_request", { workspace, workerId: parWorkerB.data.workerId, message: "DELAY:300 Parallel B" }),
  ]);
  assert.equal(parA.data.settled, true);
  assert.equal(parB.data.settled, true);
  assert.ok(parA.data.report.includes("Parallel A"));
  assert.ok(parB.data.report.includes("Parallel B"));

  // worker_request on a closed resumable worker automatically resumes it.
  const resumable = await mcp.call("worker_create", { workspace, backend: "local-resume" });
  assert.equal(resumable.data.capabilities.resume, true);
  const beforeClose = await mcp.call("worker_request", { workspace, workerId: resumable.data.workerId, message: "Before close" });
  assert.equal(beforeClose.data.settled, true);
  await mcp.call("worker_close", { workspace, workerId: resumable.data.workerId });
  for (let i = 0; i < 50; i++) {
    const check = await mcp.call("worker_discover", { workspace, target: "workers", workerId: resumable.data.workerId });
    if (!check.data.workers[0].alive) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const autoResumed = await mcp.call("worker_request", { workspace, workerId: resumable.data.workerId, message: "After close" });
  assert.equal(autoResumed.isError, false, autoResumed.text);
  assert.equal(autoResumed.data.settled, true);
  assert.ok(autoResumed.data.report.includes("After close"));
  assert.equal(autoResumed.data.report.includes("CUSTOM_EXPERT_RULE"), false);

  for (const id of [
    workerId, allowWorker.data.workerId, denyWorker.data.workerId,
    asyncWorker.data.workerId, parWorkerA.data.workerId, parWorkerB.data.workerId, resumable.data.workerId,
  ]) {
    const closed = await mcp.call("worker_close", { workspace, workerId: id });
    assert.equal(closed.isError, false);
  }

  // When PBOT_HOST is set, worker_discover(target="models") defaults to current host, while worker_create still requires explicit backend.
  const hostedChild = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir, PBOT_WORKSPACE_ROOT: workspace, PBOT_HOST: "local-acp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const hosted = new McpClient(hostedChild);
  t.after(() => hosted.close());
  await hosted.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  const defaultModels = await hosted.call("worker_discover", { workspace, target: "models" });
  assert.equal(defaultModels.isError, false, defaultModels.text);
  assert.equal(defaultModels.data.backend, "local-acp");
  const createWithoutBackend = await hosted.call("worker_create", { workspace });
  assert.equal(createWithoutBackend.isError, true);
});
