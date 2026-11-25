import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "../common/json.js";
import { isAcpBackend, requireThat } from "../common/validation.js";
import { packageVersion } from "../common/version.js";
import { AcpWorkerHost } from "../integrations/acp/agents.js";
import { inspectAcpBackends } from "../integrations/acp/launch.js";
import type { AgentOwner } from "../model/agent.js";
import { AgentService } from "../services/agents/agent-service.js";
import { readWorkspaceConfig, workspaceDisabledMessage } from "../services/workspace/workspace-config.js";

const protocolVersion = "2025-03-26";

export const pbotWorkerTool = {
  name: "pbot_worker",
  description: "跨 Harness 委派并管理独立 ACP worker（与宿主原生 subagent 互补，不干扰原生子代理）。支持已注册及 .pbot/config.json 自定义的任意 ACP v1 Harness。" +
    "backends 查看可用目标；start 启动 worker（必填 backend，可选 waitMs 同步等待）；wait 等待任务完成并返回报告；" +
    "send 继续对话（运行中用 delivery: followUp）；status 查状态；read 分页读报告；list 列出当前会话 worker；stop 停止；resume 恢复；rename 改名。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["backends", "start", "wait", "send", "status", "list", "read", "stop", "resume", "rename"] },
      workspace: { type: "string", description: "工作区根目录绝对路径；省略时取 CLAUDE_PROJECT_DIR / PBOT_WORKSPACE_ROOT / cwd。" },
      workerId: { type: "string", description: "wait/send/status/read/stop/resume/rename 必填：worker ID。" },
      backend: { type: "string", description: "start 必填：目标 ACP Harness 名称（可用 backends 查询已注册或 .pbot/config.json 自定义目标）。" },
      name: { type: "string", description: "start 可选显示名；rename 必填新名称。" },
      message: { type: "string", description: "start 可选、send/resume 必填：任务目标、相关资料、约束与交付要求。" },
      files: { type: "array", items: { type: "string" }, description: "start 可选：相对工作区根目录的附件路径。" },
      provider: { type: "string", description: "start 可选：模型提供方（须同时提供 model）。" },
      model: { type: "string", description: "start 可选：目标模型 ID。" },
      thinking: { type: "string", description: "start 可选：思考等级。" },
      cwd: { type: "string", description: "start 可选：执行目录（相对工作区根目录）。" },
      delivery: { type: "string", enum: ["steer", "followUp"], description: "send 可选：默认 followUp。" },
      cycleId: { type: "string", description: "read 可选：指定周期 ID。" },
      requestId: { type: "string", description: "wait 可选：等待包含该 requestId 的周期结束；省略时自动等待当前代次最新请求。" },
      offset: { type: "integer", minimum: 0, description: "read 可选：字符偏移，默认 0。" },
      limit: { type: "integer", minimum: 1, maximum: 16000, description: "read 可选：返回最大字符数，默认 16000。" },
      timeoutMs: { type: "integer", minimum: 100, maximum: 600000, description: "wait 可选：等待超时（毫秒），默认 120000。" },
      waitMs: { type: "integer", minimum: 0, maximum: 600000, description: "start 可选：启动后同步等待完成的时间（毫秒），默认 0 立即返回。" },
    },
  },
};

export function defaultWorkerDirectory(): string {
  if (process.env.PBOT_MCP_AGENT_DIR) return process.env.PBOT_MCP_AGENT_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "subagents");
  return join(homedir(), ".pbot/subagents");
}

function asString(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    requireThat(!required, `缺少必填参数：${key}`);
    return undefined;
  }
  requireThat(typeof value === "string" && value.length > 0, `参数 ${key} 必须是非空字符串。`);
  return value;
}

function asInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  requireThat(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max,
    `参数 ${key} 必须是 ${min}–${max} 的整数。`);
  return value;
}

function presentWorker<T extends { agentId: string }>(value: T) {
  const { agentId, ...rest } = value;
  return { workerId: agentId, ...rest };
}

export class McpWorkerRuntime {
  readonly #services = new Map<string, { service: AgentService; host: AcpWorkerHost; owner: AgentOwner }>();
  readonly #sessionId: string;
  readonly #directory: string;
  #closed = false;

  constructor(directory = defaultWorkerDirectory(), sessionId = process.env.PBOT_MCP_SESSION_ID || ("mcp-" + randomUUID())) {
    this.#directory = directory;
    this.#sessionId = sessionId;
  }

  private async resolveWorkspace(supplied?: string): Promise<string> {
    const target = supplied || process.env.CLAUDE_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT || process.cwd();
    requireThat(isAbsolute(target), "工作区需要绝对路径。");
    const root = await realpath(target);
    requireThat((await stat(root)).isDirectory(), "工作区路径不是目录。");
    return root;
  }

  private async workspace(supplied?: string) {
    requireThat(!this.#closed, "Personal Bot MCP 服务已关闭。");
    const root = await this.resolveWorkspace(supplied);
    const configuration = await readWorkspaceConfig(root);
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
    let entry = this.#services.get(root);
    if (!entry) {
      const host = new AcpWorkerHost(this.#directory, configuration.acp);
      entry = {
        host,
        service: new AgentService(root, this.#directory, host),
        owner: { sessionId: this.#sessionId, leaf: null, branch: [] },
      };
      this.#services.set(root, entry);
    } else {
      Object.assign(entry.host, { commands: configuration.acp ?? {} });
    }
    return { root, configuration, ...entry };
  }

  private async waitFor(service: AgentService, owner: AgentOwner, workerId: string, requestId: string | undefined, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = service.status(workerId, owner);
      const cycles = service.cycles(workerId, owner);
      const latestRequest = requestId ?? service.files.messages(workerId)
        .filter(item => item.generation === current.generation)
        .at(-1)?.requestId;
      const targetCycle = latestRequest
        ? cycles.find(item => item.generation === current.generation && item.requestIds.includes(latestRequest))
        : current.cycle ?? cycles.at(-1);
      const settled = targetCycle && targetCycle.state !== "running";
      const terminalWithoutCycle = !latestRequest && (current.state === "stopped" || current.state === "error" || (current.state === "idle" && !targetCycle));
      const failedBeforeCycle = Boolean(latestRequest && !targetCycle && (current.state === "stopped" || current.state === "error"));
      if (settled) {
        const page = await service.read(workerId, owner, targetCycle.cycleId, 0, 16000);
        return { settled: true, ...presentWorker(page) };
      }
      if (terminalWithoutCycle || failedBeforeCycle) {
        return { settled: true, ...presentWorker(current) };
      }
      if (Date.now() >= deadline) {
        return { settled: false, timedOut: true, ...presentWorker(current) };
      }
      await delay(100);
    }
  }

  async callTool(name: string, rawArgs: unknown): Promise<unknown> {
    requireThat(name === "pbot_worker", "未知工具：" + name);
    requireThat(object(rawArgs), "工具参数必须是对象。");
    const action = asString(rawArgs, "action", true)!;
    const { configuration, service, owner } = await this.workspace(asString(rawArgs, "workspace"));

    switch (action) {
      case "backends":
        return { backends: inspectAcpBackends(configuration.acp) };
      case "list":
        return { workers: service.list(owner).map(presentWorker) };
      case "start": {
        const backend = asString(rawArgs, "backend", true)!;
        requireThat(isAcpBackend(backend), "无效的 ACP backend 名称：" + backend);
        const files = rawArgs.files === undefined ? undefined : (requireThat(Array.isArray(rawArgs.files) && rawArgs.files.every(item => typeof item === "string"), "files 必须是字符串数组。"), rawArgs.files as string[]);
        const workerName = asString(rawArgs, "name");
        const message = asString(rawArgs, "message");
        const provider = asString(rawArgs, "provider");
        const model = asString(rawArgs, "model");
        const thinking = asString(rawArgs, "thinking");
        const cwd = asString(rawArgs, "cwd");
        const created = await service.start({
          backend,
          ...(workerName ? { name: workerName } : {}),
          ...(message ? { message } : {}),
          ...(files ? { files } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(cwd ? { cwd } : {}),
        }, owner);
        const waitMs = asInt(rawArgs, "waitMs", 0, 600_000) ?? 0;
        if (waitMs > 0 && created.requestId) {
          return this.waitFor(service, owner, created.agentId, created.requestId, waitMs);
        }
        return presentWorker(created);
      }
      case "wait": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const timeoutMs = asInt(rawArgs, "timeoutMs", 100, 600_000) ?? 120_000;
        return this.waitFor(service, owner, workerId, asString(rawArgs, "requestId"), timeoutMs);
      }
      case "send": {
        const workerId = asString(rawArgs, "workerId", true)!;
        const message = asString(rawArgs, "message", true)!;
        const delivery = asString(rawArgs, "delivery") ?? "followUp";
        requireThat(delivery === "steer" || delivery === "followUp", "delivery 必须是 steer 或 followUp。");
        return presentWorker(service.send(workerId, message, delivery, owner));
      }
      case "status":
        return presentWorker(service.status(asString(rawArgs, "workerId", true)!, owner));
      case "read":
        return presentWorker(await service.read(
          asString(rawArgs, "workerId", true)!,
          owner,
          asString(rawArgs, "cycleId"),
          asInt(rawArgs, "offset", 0, 10_000_000),
          asInt(rawArgs, "limit", 1, 16_000),
        ));
      case "stop":
        return presentWorker(service.stop(asString(rawArgs, "workerId", true)!, owner));
      case "resume":
        return presentWorker(await service.resume(asString(rawArgs, "workerId", true)!, asString(rawArgs, "message", true)!, owner));
      case "rename":
        return presentWorker(service.rename(asString(rawArgs, "workerId", true)!, asString(rawArgs, "name", true)!, owner));
      default:
        throw new Error("未知 action：" + action);
    }
  }

  async close(preserve = false): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#services.values()];
    this.#services.clear();
    await Promise.allSettled(entries.map(({ service, owner }) => service.close(owner, preserve)));
  }
}

export async function handleMcpRequest(runtime: McpWorkerRuntime, message: unknown): Promise<Record<string, unknown> | null> {
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  const hasId = Object.hasOwn(message, "id") && message.id !== undefined;
  const id = hasId ? message.id : null;
  if (!hasId) return null; // Notifications expect no response.

  try {
    if (message.method === "initialize") {
      const requested = object(message.params) && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested || protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "personal-bot", version: packageVersion },
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: [pbotWorkerTool] } };
    }
    if (message.method === "tools/call") {
      requireThat(object(message.params) && typeof message.params.name === "string", "tools/call 缺少 name。");
      try {
        const result = await runtime.callTool(message.params.name, message.params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          },
        };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + message.method } };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function serveMcpStdio(runtime = new McpWorkerRuntime()): Promise<void> {
  const shutdown = () => { void runtime.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  let buffer = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      queue = queue.then(async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(line); }
        catch {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
          return;
        }
        const reply = await handleMcpRequest(runtime, parsed);
        if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
      });
    }
  }
  await queue;
  await runtime.close();
}
