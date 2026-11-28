import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { WorkspaceMcpBridge } from "../../dist/extension/mcp/bridge.js";

const exec = promisify(execFile);
const builtBundle = resolve("lib/antigravity-plugin");
const cliEntry = resolve("bin/pbot.mjs");

// Minimal real stdio MCP server with pagination, env/cwd echo, and error reporting.
const stdioMcpScript = `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const tag = process.argv[2] || "v1";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-stdio", version: "1.0.0" } },
      });
    } else if (msg.method === "tools/list") {
      if (!msg.params?.cursor) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{ name: "echo_env", description: "Echo env and cwd", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }],
            nextCursor: "page-2",
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{ name: "fail_tool", description: "Return isError", inputSchema: { type: "object" } }],
          },
        });
      }
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "fail_tool") {
        send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "EXPECTED_DOWNSTREAM_ERROR" }] } });
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                tag,
                msg: msg.params.arguments?.msg ?? "",
                secret: process.env.DOWNSTREAM_SECRET ?? "",
                cwd: process.cwd(),
              }),
            }],
          },
        });
      }
    }
  }
});
`;

// Real ACP v1 server echoing session/new mcpServers and received prompts.
const acpEchoMcpScript = `#!/usr/bin/env node
let buffer = "";
let receivedMcpServers = [];
let receivedSystemPrompt = "";
const supportsHttp = process.env.TEST_ACP_HTTP_MCP === "1";
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
            mcpCapabilities: { http: supportsHttp, sse: false },
            sessionCapabilities: { close: {}, systemPrompt: { append: true } },
          },
        },
      });
    } else if (msg.method === "session/new") {
      receivedMcpServers = msg.params?.mcpServers ?? [];
      receivedSystemPrompt = (msg.params?.systemPrompt?.content ?? []).map(c => c.text ?? "").join("\\n");
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-mcp-1", configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      const promptText = (msg.params?.prompt ?? []).map(c => c.text ?? "").join("\\n");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m-1",
            content: {
              type: "text",
              text: JSON.stringify({ mcpServers: receivedMcpServers, systemPrompt: receivedSystemPrompt, prompt: promptText }),
            },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
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
        if (msg.id === undefined) continue;
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
  async call(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
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

async function startHttpMcpServer(t, beforeInitialize) {
  let deleted = false;
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const auth = req.headers.authorization || "";
      const session = req.headers["mcp-session-id"] || "";
      if (msg.method === "initialize") {
        await beforeInitialize?.();
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "http-sess-42" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-http", version: "1.0.0" } },
        }));
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              { name: "http_json", description: "JSON response", inputSchema: { type: "object" } },
              { name: "http_sse", description: "SSE response", inputSchema: { type: "object" } },
            ],
          },
        }));
        return;
      }
      if (msg.method === "tools/call") {
        const payload = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ auth, session, tool: msg.params.name, args: msg.params.arguments }) }],
          },
        };
        if (msg.params.name === "http_sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise(resolveClose => server.close(() => resolveClose())));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/mcp`, isDeleted: () => deleted };
}

test("workspace MCP bridge serves stdio and Streamable HTTP servers, hot-reloads, passes to ACP workers, and supports worker-only mode", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-mcp-bridge-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const httpServer = await startHttpMcpServer(t);
  const pluginDir = join(root, "plugin");
  const workspace = join(root, "workspace");
  const subdir = join(workspace, "sub");
  const workerOnlyWorkspace = join(root, "worker-only");
  const controlDir = join(root, "subagents");
  const stdioBin = join(root, "local-stdio-mcp.mjs");
  const acpBin = join(root, "local-acp-mcp.mjs");
  await Promise.all([
    cp(builtBundle, pluginDir, { recursive: true }),
    mkdir(join(workspace, ".pbot"), { recursive: true }),
    mkdir(subdir, { recursive: true }),
    mkdir(join(workspace, ".agents/skills/cross-skill"), { recursive: true }),
    mkdir(join(workerOnlyWorkspace, ".pbot"), { recursive: true }),
    mkdir(join(workerOnlyWorkspace, ".agents/skills/hidden-skill"), { recursive: true }),
    writeFile(stdioBin, stdioMcpScript, { mode: 0o755 }),
    writeFile(acpBin, acpEchoMcpScript, { mode: 0o755 }),
  ]);
  await writeFile(join(workspace, ".agents/skills/cross-skill/SKILL.md"), "---\nname: cross-skill\ndescription: Shared workflow across all harnesses\n---\nBody\n");
  await writeFile(join(workerOnlyWorkspace, ".agents/skills/hidden-skill/SKILL.md"), "---\nname: hidden-skill\ndescription: Should not be injected\n---\nBody\n");
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    acp: {
      "echo-http": { command: process.execPath, args: [acpBin], env: { TEST_ACP_HTTP_MCP: "1" } },
      "echo-stdio": { command: process.execPath, args: [acpBin], env: { TEST_ACP_HTTP_MCP: "0" } },
    },
  }));
  await writeFile(join(workspace, ".pbot/mcp.json"), JSON.stringify({
    mcpServers: {
      "local-stdio": {
        command: process.execPath,
        args: [stdioBin, "v1"],
        env: { DOWNSTREAM_SECRET: "${TEST_STDIO_SECRET}" },
        cwd: "sub",
        description: "Local stdio test server",
      },
      "local-http": {
        url: httpServer.url,
        headers: { Authorization: "Bearer ${TEST_HTTP_TOKEN}" },
        description: "Local HTTP test server",
      },
      disabled: {
        command: process.execPath,
        args: [stdioBin],
        enabled: false,
      },
    },
  }));
  await writeFile(join(workerOnlyWorkspace, ".pbot/config.json"), JSON.stringify({
    enabled: true,
    features: { prompts: false, skills: false, mcp: false, history: false },
    acp: {
      "echo-http": { command: process.execPath, args: [acpBin], env: { TEST_ACP_HTTP_MCP: "1" } },
    },
  }));
  await writeFile(join(workerOnlyWorkspace, ".pbot/mcp.json"), JSON.stringify({
    mcpServers: {
      "local-stdio": { command: process.execPath, args: [stdioBin, "disabled-feature"] },
    },
  }));

  const child = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      PBOT_MCP_AGENT_DIR: controlDir,
      TEST_STDIO_SECRET: "stdio-secret-123",
      TEST_HTTP_TOKEN: "http-token-456",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(() => mcp.close());
  await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });

  // 1. Discover servers without connecting.
  const listedServers = await mcp.call("workspace_mcp_discover", { workspace });
  assert.equal(listedServers.isError, false, listedServers.text);
  assert.deepEqual(listedServers.data.servers.map(item => item.name), ["local-stdio", "local-http", "disabled"]);
  assert.equal(listedServers.data.servers.find(item => item.name === "local-stdio").transport, "stdio");
  assert.equal(listedServers.data.servers.find(item => item.name === "local-http").transport, "http");
  assert.equal(listedServers.data.servers.find(item => item.name === "disabled").enabled, false);

  // 2. Discover stdio server tools (follows pagination, no filtering).
  const stdioTools = await mcp.call("workspace_mcp_discover", { workspace, server: "local-stdio" });
  assert.equal(stdioTools.isError, false, stdioTools.text);
  assert.deepEqual(stdioTools.data.tools.map(item => item.name), ["echo_env", "fail_tool"]);

  // 3. Call stdio tool with env expansion and relative cwd.
  const stdioResult = await mcp.call("workspace_mcp_call", {
    workspace,
    server: "local-stdio",
    tool: "echo_env",
    arguments: { msg: "hello-stdio" },
  });
  assert.equal(stdioResult.isError, false, stdioResult.text);
  assert.equal(stdioResult.data.isError, false);
  const stdioEcho = JSON.parse(stdioResult.data.content[0].text);
  assert.deepEqual(stdioEcho, { tag: "v1", msg: "hello-stdio", secret: "stdio-secret-123", cwd: subdir });

  const stdioFail = await mcp.call("workspace_mcp_call", { workspace, server: "local-stdio", tool: "fail_tool" });
  assert.equal(stdioFail.isError, false);
  assert.equal(stdioFail.data.isError, true);
  assert.equal(stdioFail.data.content[0].text, "EXPECTED_DOWNSTREAM_ERROR");

  // 4. Discover & call Streamable HTTP server (both JSON and SSE + session ID + expanded headers).
  const httpTools = await mcp.call("workspace_mcp_discover", { workspace, server: "local-http" });
  assert.equal(httpTools.isError, false, httpTools.text);
  assert.deepEqual(httpTools.data.tools.map(item => item.name), ["http_json", "http_sse"]);

  const httpJson = await mcp.call("workspace_mcp_call", { workspace, server: "local-http", tool: "http_json", arguments: { n: 1 } });
  assert.equal(httpJson.isError, false, httpJson.text);
  assert.deepEqual(JSON.parse(httpJson.data.content[0].text), {
    auth: "Bearer http-token-456",
    session: "http-sess-42",
    tool: "http_json",
    args: { n: 1 },
  });

  const httpSse = await mcp.call("workspace_mcp_call", { workspace, server: "local-http", tool: "http_sse", arguments: { n: 2 } });
  assert.equal(httpSse.isError, false, httpSse.text);
  assert.deepEqual(JSON.parse(httpSse.data.content[0].text), {
    auth: "Bearer http-token-456",
    session: "http-sess-42",
    tool: "http_sse",
    args: { n: 2 },
  });

  // 5. Hot-reload when .pbot/mcp.json changes without restarting the MCP server.
  await writeFile(join(workspace, ".pbot/mcp.json"), JSON.stringify({
    mcpServers: {
      "local-stdio": {
        command: process.execPath,
        args: [stdioBin, "v2"],
        env: { DOWNSTREAM_SECRET: "${TEST_STDIO_SECRET}" },
        cwd: "sub",
      },
      "local-http": {
        url: httpServer.url,
        headers: { Authorization: "Bearer ${TEST_HTTP_TOKEN}" },
      },
    },
  }));
  const reloaded = await mcp.call("workspace_mcp_call", { workspace, server: "local-stdio", tool: "echo_env", arguments: { msg: "after-edit" } });
  assert.equal(reloaded.isError, false, reloaded.text);
  assert.equal(JSON.parse(reloaded.data.content[0].text).tag, "v2");

  // 6. ACP workers receive workspace MCP servers via ACP v1 session/new mcpServers + S1 skills index.
  const workerWithHttp = await mcp.call("worker_create", { workspace, backend: "echo-http" });
  assert.equal(workerWithHttp.isError, false, workerWithHttp.text);
  const replyHttp = await mcp.call("worker_request", { workspace, workerId: workerWithHttp.data.workerId, message: "inspect" });
  assert.equal(replyHttp.isError, false, replyHttp.text);
  const parsedHttp = JSON.parse(replyHttp.data.report);
  assert.deepEqual(parsedHttp.mcpServers.map(item => item.name), ["local-stdio", "local-http"]);
  assert.equal(parsedHttp.mcpServers[0].command, process.execPath);
  assert.deepEqual(parsedHttp.mcpServers[0].env, [{ name: "DOWNSTREAM_SECRET", value: "stdio-secret-123" }]);
  assert.equal(parsedHttp.mcpServers[1].type, "http");
  assert.deepEqual(parsedHttp.mcpServers[1].headers, [{ name: "Authorization", value: "Bearer http-token-456" }]);
  assert.ok(parsedHttp.systemPrompt.includes("cross-skill"));
  assert.ok(parsedHttp.systemPrompt.includes(".agents/skills/cross-skill/SKILL.md"));
  await mcp.call("worker_close", { workspace, workerId: workerWithHttp.data.workerId });

  // ACP backend without http capability receives only stdio MCP servers.
  const workerStdioOnly = await mcp.call("worker_create", { workspace, backend: "echo-stdio" });
  assert.equal(workerStdioOnly.isError, false, workerStdioOnly.text);
  const replyStdio = await mcp.call("worker_request", { workspace, workerId: workerStdioOnly.data.workerId, message: "inspect" });
  assert.equal(replyStdio.isError, false, replyStdio.text);
  assert.deepEqual(JSON.parse(replyStdio.data.report).mcpServers.map(item => item.name), ["local-stdio"]);
  await mcp.call("worker_close", { workspace, workerId: workerStdioOnly.data.workerId });

  // 7. Worker-only mode (features: { prompts: false, skills: false, mcp: false }).
  const deniedBridge = await mcp.call("workspace_mcp_discover", { workspace: workerOnlyWorkspace });
  assert.equal(deniedBridge.isError, true);
  assert.ok(deniedBridge.text.includes("features.mcp"));

  const pureWorker = await mcp.call("worker_create", { workspace: workerOnlyWorkspace, backend: "echo-http" });
  assert.equal(pureWorker.isError, false, pureWorker.text);
  const pureReply = await mcp.call("worker_request", { workspace: workerOnlyWorkspace, workerId: pureWorker.data.workerId, message: "pure-worker-task" });
  assert.equal(pureReply.isError, false, pureReply.text);
  const parsedPure = JSON.parse(pureReply.data.report);
  assert.deepEqual(parsedPure.mcpServers, []);
  assert.equal(parsedPure.systemPrompt, "");
  assert.equal(parsedPure.prompt, "pure-worker-task");
  await mcp.call("worker_close", { workspace: workerOnlyWorkspace, workerId: pureWorker.data.workerId });

  // Bound worker-only MCP process omits workspace_mcp_* from tools/list while keeping all 6 worker_* tools.
  const boundChild = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir, PBOT_WORKSPACE_ROOT: workerOnlyWorkspace },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bound = new McpClient(boundChild);
  t.after(() => bound.close());
  await bound.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  const boundTools = (await bound.request("tools/list")).result.tools.map(tool => tool.name);
  assert.deepEqual(boundTools, ["worker_create", "worker_close", "worker_request", "worker_response", "worker_output", "worker_discover"]);

  // Native-mount host (PBOT_NATIVE_WORKSPACE_MCP=1, e.g. Pi/dsh) omits workspace_mcp_* and rejects bridge calls even when features.mcp is true.
  const nativeChild = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      PBOT_MCP_AGENT_DIR: controlDir,
      PBOT_WORKSPACE_ROOT: workspace,
      PBOT_NATIVE_WORKSPACE_MCP: "1",
      PBOT_NATIVE_HISTORY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const nativeMcp = new McpClient(nativeChild);
  t.after(() => nativeMcp.close());
  const nativeInit = await nativeMcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  assert.equal(nativeInit.result.instructions.includes("workspace_mcp_"), false);
  const nativeTools = (await nativeMcp.request("tools/list")).result.tools.map(tool => tool.name);
  assert.deepEqual(nativeTools, ["worker_create", "worker_close", "worker_request", "worker_response", "worker_output", "worker_discover"]);
  const rejectedNativeCall = await nativeMcp.call("workspace_mcp_discover", { workspace });
  assert.equal(rejectedNativeCall.isError, true);
  assert.ok(rejectedNativeCall.text.includes("原生挂载"));

  // 8. CLI `pbot mcp add|list|remove` manages `.pbot/mcp.json`.
  const cliWorkspace = join(root, "cli-ws");
  await mkdir(cliWorkspace, { recursive: true });
  const addStdio = JSON.parse((await exec(process.execPath, [
    cliEntry, "mcp", "add", "demo-stdio", "--workspace", cliWorkspace,
    "--env", "TOKEN=${DEMO_TOKEN}", "--cwd", ".", "--description", "Demo stdio", "--", process.execPath, stdioBin,
  ])).stdout);
  assert.equal(addStdio.name, "demo-stdio");
  assert.equal(addStdio.server.env.TOKEN, "${DEMO_TOKEN}");

  const addHttp = JSON.parse((await exec(process.execPath, [
    cliEntry, "mcp", "add", "demo-http", "--workspace", cliWorkspace,
    "--url", "https://mcp.example.test/mcp", "--header", "Authorization=Bearer ${TOKEN}", "--timeout", "30",
  ])).stdout);
  assert.equal(addHttp.server.url, "https://mcp.example.test/mcp");
  assert.equal(addHttp.server.timeout, 30);

  await assert.rejects(exec(process.execPath, [
    cliEntry, "mcp", "add", "pbot", "--workspace", cliWorkspace, "--url", "https://mcp.example.test/mcp",
  ]));

  const listedCli = JSON.parse((await exec(process.execPath, [cliEntry, "mcp", "list", "--workspace", cliWorkspace])).stdout);
  assert.deepEqual(Object.keys(listedCli.mcpServers), ["demo-stdio", "demo-http"]);

  const removedCli = JSON.parse((await exec(process.execPath, [cliEntry, "mcp", "remove", "demo-stdio", "--workspace", cliWorkspace])).stdout);
  assert.equal(removedCli.removed, true);
  const storedFile = JSON.parse(await readFile(join(cliWorkspace, ".pbot/mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(storedFile.mcpServers), ["demo-http"]);
});

test("changing a server during its handshake routes concurrent calls to the requested configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-bridge-handshake-"));
  const dir = join(root, ".pbot");
  await mkdir(dir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = new WorkspaceMcpBridge();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const old = await startHttpMcpServer(t, () => {
    started.resolve();
    return release.promise;
  });
  const current = await startHttpMcpServer(t, release.resolve);
  const configure = (url, authorization) => writeFile(join(dir, "mcp.json"), JSON.stringify({
    mcpServers: { shared: { url, timeout: 3, headers: { authorization } } },
  }));
  try {
    await configure(old.url, "first");
    const first = bridge.call(root, "shared", "http_json");
    await started.promise;
    await configure(current.url, "second");
    const second = bridge.call(root, "shared", "http_json");
    // Only the second endpoint can release the first handshake.
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map(reply => JSON.parse(reply.content[0].text).auth), ["first", "second"]);
  } finally {
    release.resolve();
    await bridge.close();
  }
  assert.equal(old.isDeleted(), true);
  assert.equal(current.isDeleted(), true);
});
