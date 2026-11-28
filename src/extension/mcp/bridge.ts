import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import type {
  WorkspaceMcpConfiguration,
  ResolvedWorkspaceMcpHttpServer,
  ResolvedWorkspaceMcpServer,
  ResolvedWorkspaceMcpStdioServer,
} from "../../model/workspace-mcp.js";
import {
  readWorkspaceMcpConfig,
  resolveWorkspaceMcpServer,
  resolveWorkspaceMcpServers,
} from "../../services/workspace/workspace-mcp.js";

const protocolVersion = "2025-03-26";
const maxStderrBytes = 4096;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface DownstreamClient {
  readonly fingerprint: string;
  readonly alive: boolean;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function rpcError(server: string, method: string, error: { code?: number; message?: string; data?: unknown }): Error {
  const detail = error.data !== undefined ? `（${JSON.stringify(error.data)}）` : "";
  return new Error(`MCP 服务 "${server}" 调用 ${method} 失败：${error.message ?? "未知错误"}${detail}`);
}

class StdioMcpClient implements DownstreamClient {
  readonly fingerprint: string;
  readonly #server: ResolvedWorkspaceMcpStdioServer;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #alive = true;
  #closing: Promise<void> | undefined;

  constructor(server: ResolvedWorkspaceMcpStdioServer, fingerprint: string) {
    this.#server = server;
    this.fingerprint = fingerprint;
    this.#child = spawn(server.command, server.args, {
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#exited = new Promise(resolveExit => this.#child.once("close", () => resolveExit()));
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdin.on("error", () => {});
    this.#child.stderr.on("data", chunk => {
      this.#stderr = (this.#stderr + String(chunk)).slice(-maxStderrBytes);
    });
    this.#child.stdout.on("data", chunk => this.#onData(String(chunk)));
    this.#child.once("error", error => this.#failAll(new Error(`MCP 服务 "${server.name}" 启动失败：${error.message}`)));
    this.#child.once("exit", (code, signal) => {
      const stderr = this.#stderr.trim();
      const suffix = stderr ? `\nstderr: ${stderr}` : "";
      this.#failAll(new Error(`MCP 服务 "${server.name}" 进程已退出（${signal ?? code ?? "unknown"}）。${suffix}`));
    });
  }

  get alive(): boolean {
    return this.#alive && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  #failAll(error: Error) {
    this.#alive = false;
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.#pending.delete(id);
    }
  }

  #onData(chunk: string) {
    this.#buffer += chunk;
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!object(parsed) || typeof parsed.id !== "number") continue;
      const entry = this.#pending.get(parsed.id);
      if (!entry) continue;
      this.#pending.delete(parsed.id);
      clearTimeout(entry.timer);
      const response = parsed as JsonRpcResponse;
      if (response.error) entry.reject(rpcError(this.#server.name, "request", response.error));
      else entry.resolve(response.result);
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "personal-bot", version: packageVersion },
    });
    if (this.alive) {
      this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`MCP 服务 "${this.#server.name}" 连接已断开。`));
    const id = this.#nextId++;
    const timeoutMs = this.#server.timeout * 1000;
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(new Error(`MCP 服务 "${this.#server.name}" 调用 ${method} 超时（${this.#server.timeout}s）。`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      try {
        this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectResponse(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#alive = false;
      this.#failAll(new Error(`MCP 服务 "${this.#server.name}" 已关闭。`));
      try { this.#child.stdin.end(); } catch { /* ignore */ }
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
      const grace = new AbortController();
      try { await Promise.race([this.#exited, delay(1500, undefined, { signal: grace.signal })]); }
      finally { grace.abort(); }
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
      await this.#exited;
    })();
  }
}

function parseSseJsonRpc(body: string, expectedId: number): JsonRpcResponse | undefined {
  const blocks = body.split(/\r?\n\r?\n/);
  let fallback: JsonRpcResponse | undefined;
  for (const block of blocks) {
    const dataLines = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (!object(parsed)) continue;
    const message = parsed as JsonRpcResponse;
    if (message.id === expectedId) return message;
    if (message.result !== undefined || message.error !== undefined) fallback = message;
  }
  return fallback;
}

class HttpMcpClient implements DownstreamClient {
  readonly fingerprint: string;
  readonly #server: ResolvedWorkspaceMcpHttpServer;
  #nextId = 1;
  #sessionId: string | undefined;
  #closed = false;

  constructor(server: ResolvedWorkspaceMcpHttpServer, fingerprint: string) {
    this.#server = server;
    this.fingerprint = fingerprint;
  }

  get alive(): boolean {
    return !this.#closed;
  }

  #headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.#server.headers,
      ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
    };
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "personal-bot", version: packageVersion },
    });
    // Send initialized notification; Streamable HTTP servers may reply 202/204/405.
    try {
      await fetch(this.#server.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: AbortSignal.timeout(Math.min(this.#server.timeout * 1000, 10_000)),
      });
    } catch { /* Non-fatal per Streamable HTTP compatibility. */ }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    requireThat(!this.#closed, `MCP 服务 "${this.#server.name}" 连接已关闭。`);
    const id = this.#nextId++;
    const response = await fetch(this.#server.url, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(this.#server.timeout * 1000),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP 服务 "${this.#server.name}" HTTP ${response.status}：${text.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: JsonRpcResponse | undefined;
    if (contentType.includes("text/event-stream")) {
      parsed = parseSseJsonRpc(text, id);
    } else if (text.trim()) {
      const raw: unknown = JSON.parse(text);
      if (Array.isArray(raw)) {
        parsed = raw.find(item => object(item) && item.id === id) as JsonRpcResponse | undefined;
      } else if (object(raw)) {
        parsed = raw as JsonRpcResponse;
      }
    }
    requireThat(parsed !== undefined, `MCP 服务 "${this.#server.name}" 返回空响应（${method}）。`);
    if (parsed.error) throw rpcError(this.#server.name, method, parsed.error);
    return parsed.result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sessionId) {
      try {
        await fetch(this.#server.url, {
          method: "DELETE",
          headers: this.#headers(),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* Best-effort session teardown. */ }
    }
  }
}

function configuredServer(root: string, configuration: WorkspaceMcpConfiguration, serverName: string) {
  const raw = Object.hasOwn(configuration.servers, serverName) ? configuration.servers[serverName] : undefined;
  requireThat(raw, `工作区未注册名为 "${serverName}" 的 MCP 服务（已注册：${Object.keys(configuration.servers).join(", ") || "无"}）。`);
  requireThat(raw.enabled !== false, `工作区 MCP 服务 "${serverName}" 当前已停用（enabled: false）。`);
  return resolveWorkspaceMcpServer(root, serverName, raw);
}

interface Connection {
  key: string;
  client: DownstreamClient;
  ready: Promise<void>;
  users: number;
  retired: boolean;
  closing?: Promise<void>;
}

export class WorkspaceMcpBridge {
  readonly #connections = new Set<Connection>();
  #closing: Promise<void> | undefined;

  #close(connection: Connection): Promise<void> {
    return connection.closing ??= connection.ready.catch(() => {}).then(() => connection.client.close())
      .finally(() => this.#connections.delete(connection));
  }

  #retire(connection: Connection): Promise<void> | undefined {
    connection.retired = true;
    if (!connection.users) return this.#close(connection);
  }

  async #withClient<T>(
    root: string, server: ResolvedWorkspaceMcpServer, operation: (client: DownstreamClient) => Promise<T>,
  ): Promise<T> {
    requireThat(!this.#closing, "Workspace MCP 桥接已关闭。");
    const key = `${root}\0${server.name}`;
    const fingerprint = JSON.stringify(server);
    let connection = [...this.#connections].find(entry => entry.key === key && !entry.retired);
    if (connection && (!connection.client.alive || connection.client.fingerprint !== fingerprint)) {
      void this.#retire(connection)?.catch(() => {});
      connection = undefined;
    }
    if (!connection) {
      const client = server.transport === "http"
        ? new HttpMcpClient(server, fingerprint)
        : new StdioMcpClient(server, fingerprint);
      connection = { key, client, ready: client.initialize(), users: 0, retired: false };
      this.#connections.add(connection);
    }

    connection.users++;
    try {
      try { await connection.ready; }
      catch (error) { connection.retired = true; throw error; }
      requireThat(!this.#closing, "Workspace MCP 桥接已关闭。");
      return await operation(connection.client);
    } finally {
      connection.users--;
      if (connection.retired && !connection.users) await this.#close(connection).catch(() => {});
    }
  }

  async #pruneRemoved(root: string, activeNames: ReadonlySet<string>): Promise<void> {
    const prefix = `${root}\0`;
    await Promise.allSettled([...this.#connections]
      .filter(entry => entry.key.startsWith(prefix) && !activeNames.has(entry.key.slice(prefix.length)))
      .map(entry => this.#retire(entry)));
  }

  async discover(root: string, serverName?: string) {
    requireThat(!this.#closing, "Workspace MCP 桥接已关闭。");
    const configuration = await readWorkspaceMcpConfig(root);
    if (configuration.error) throw new Error(configuration.error);
    const enabledNames = new Set(
      Object.entries(configuration.servers)
        .filter(([, entry]) => entry.enabled !== false)
        .map(([name]) => name),
    );
    await this.#pruneRemoved(root, enabledNames);

    if (!serverName) {
      const servers = Object.entries(configuration.servers).map(([name, entry]) => ({
        name,
        transport: "url" in entry ? "http" : "stdio",
        enabled: entry.enabled !== false,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.timeout ? { timeout: entry.timeout } : {}),
        ...("url" in entry ? { url: entry.url } : { command: entry.command, args: entry.args ?? [] }),
      }));
      return {
        workspace: root,
        configPath: configuration.path,
        servers,
      };
    }

    const resolved = configuredServer(root, configuration, serverName);
    return this.#withClient(root, resolved, async client => {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.request("tools/list", cursor ? { cursor } : {});
        if (object(page) && Array.isArray(page.tools)) tools.push(...page.tools);
        const next = object(page) && typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
        if (!next) break;
        cursor = next;
      }
      return {
        workspace: root,
        server: resolved.name,
        transport: resolved.transport,
        ...(resolved.description ? { description: resolved.description } : {}),
        tools,
      };
    });
  }

  async call(root: string, serverName: string, toolName: string, args: Record<string, unknown> = {}) {
    requireThat(!this.#closing, "Workspace MCP 桥接已关闭。");
    const configuration = await readWorkspaceMcpConfig(root);
    if (configuration.error) throw new Error(configuration.error);
    const resolved = configuredServer(root, configuration, serverName);
    const result = await this.#withClient(root, resolved, client =>
      client.request("tools/call", { name: toolName, arguments: args }));
    if (object(result)) {
      return {
        server: resolved.name,
        tool: toolName,
        isError: result.isError === true,
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      };
    }
    return {
      server: resolved.name,
      tool: toolName,
      isError: false,
      content: result === undefined ? [] : [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  close(): Promise<void> {
    return this.#closing ??= Promise.allSettled([...this.#connections].map(entry => this.#close(entry))).then(() => {});
  }
}

export { resolveWorkspaceMcpServers };
