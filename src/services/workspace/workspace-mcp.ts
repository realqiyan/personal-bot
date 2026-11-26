import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import type {
  ResolvedWorkspaceMcpServer,
  WorkspaceMcpConfig,
  WorkspaceMcpConfiguration,
  WorkspaceMcpHttpServer,
  WorkspaceMcpServer,
  WorkspaceMcpStdioServer,
} from "../../model/workspace-mcp.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";

const serverNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const reservedServerNames = new Set(["pbot"]);
const stdioKeys = new Set(["command", "args", "env", "cwd", "description", "timeout", "enabled"]);
const httpKeys = new Set(["url", "headers", "description", "timeout", "enabled"]);
const defaultTimeoutSeconds = 60;
const envPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function isWorkspaceMcpServerName(name: string): boolean {
  return serverNamePattern.test(name) && !reservedServerNames.has(name.toLowerCase());
}

export function isWorkspaceMcpHttpServer(server: WorkspaceMcpServer): server is WorkspaceMcpHttpServer {
  return "url" in server && typeof server.url === "string";
}

function validateStringRecord(value: unknown, label: string): Record<string, string> {
  requireThat(object(value), `${label} 必须是字符串映射。`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    requireThat(key.length > 0 && !key.includes("\0") && typeof entry === "string" && !entry.includes("\0"),
      `${label}.${key} 必须是非空键与无空字节字符串值。`);
    result[key] = entry;
  }
  return result;
}

export function validateWorkspaceMcpServer(name: string, value: unknown): WorkspaceMcpServer {
  requireThat(serverNamePattern.test(name), `MCP 服务名无效：${name}（需匹配 [A-Za-z0-9][A-Za-z0-9_-]{0,31}）。`);
  requireThat(!reservedServerNames.has(name.toLowerCase()), `MCP 服务名 "${name}" 为 Personal Bot 保留名称。`);
  requireThat(object(value), `MCP 服务 "${name}" 配置必须是 JSON 对象。`);
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  requireThat(hasCommand !== hasUrl, `MCP 服务 "${name}" 必须且只能声明 command（stdio）或 url（Streamable HTTP）之一。`);

  const allowed = hasCommand ? stdioKeys : httpKeys;
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  requireThat(unknown.length === 0, `MCP 服务 "${name}" 包含未知字段：${unknown.join(", ")}。`);

  if (value.description !== undefined) {
    requireThat(typeof value.description === "string" && !value.description.includes("\0"),
      `MCP 服务 "${name}" 的 description 必须是字符串。`);
  }
  if (value.timeout !== undefined) {
    requireThat(typeof value.timeout === "number" && Number.isInteger(value.timeout) && value.timeout >= 1 && value.timeout <= 3600,
      `MCP 服务 "${name}" 的 timeout 必须是 1–3600 的整数秒。`);
  }
  if (value.enabled !== undefined) {
    requireThat(typeof value.enabled === "boolean", `MCP 服务 "${name}" 的 enabled 必须是布尔值。`);
  }

  const base = {
    ...(value.description !== undefined ? { description: value.description as string } : {}),
    ...(value.timeout !== undefined ? { timeout: value.timeout as number } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled as boolean } : {}),
  };

  if (hasCommand) {
    requireThat(typeof value.command === "string" && value.command.trim().length > 0 && !value.command.includes("\0"),
      `MCP 服务 "${name}" 的 command 必须是非空字符串。`);
    let args: string[] | undefined;
    if (value.args !== undefined) {
      requireThat(Array.isArray(value.args) && value.args.every(item => typeof item === "string" && !item.includes("\0")),
        `MCP 服务 "${name}" 的 args 必须是字符串数组。`);
      args = [...(value.args as string[])];
    }
    const env = value.env !== undefined ? validateStringRecord(value.env, `MCP 服务 "${name}" 的 env`) : undefined;
    let cwd: string | undefined;
    if (value.cwd !== undefined) {
      requireThat(typeof value.cwd === "string" && value.cwd.trim().length > 0 && !value.cwd.includes("\0"),
        `MCP 服务 "${name}" 的 cwd 必须是非空字符串。`);
      cwd = value.cwd;
    }
    const entry: WorkspaceMcpStdioServer = {
      command: value.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...base,
    };
    return entry;
  }

  requireThat(typeof value.url === "string" && value.url.trim().length > 0 && !value.url.includes("\0"),
    `MCP 服务 "${name}" 的 url 必须是非空字符串。`);
  const rawUrl = value.url.trim();
  requireThat(/^https?:\/\/.+/.test(rawUrl) || envPattern.test(rawUrl),
    `MCP 服务 "${name}" 的 url 必须以 http:// 或 https:// 开头。`);
  envPattern.lastIndex = 0;
  const headers = value.headers !== undefined ? validateStringRecord(value.headers, `MCP 服务 "${name}" 的 headers`) : undefined;
  const entry: WorkspaceMcpHttpServer = {
    url: rawUrl,
    ...(headers ? { headers } : {}),
    ...base,
  };
  return entry;
}

function validateMcpFile(value: unknown): WorkspaceMcpConfig {
  requireThat(object(value), "工作区 MCP 配置必须是 JSON 对象。");
  const rawServers = value.mcpServers;
  requireThat(rawServers !== undefined && object(rawServers), "工作区 MCP 配置需要 mcpServers 对象。");
  const servers: Record<string, WorkspaceMcpServer> = {};
  for (const [name, entry] of Object.entries(rawServers)) {
    servers[name] = validateWorkspaceMcpServer(name, entry);
  }
  return { mcpServers: servers };
}

export function workspaceMcpPath(root: string): string {
  return join(root, ".pbot", "mcp.json");
}

export async function readWorkspaceMcpConfig(root: string): Promise<WorkspaceMcpConfiguration> {
  const path = workspaceMcpPath(root);
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, present: false, servers: {} };
    return { path, present: true, servers: {}, error: `无法读取工作区 MCP 配置 ${path}: ${String(error)}` };
  }
  try {
    const parsed = validateMcpFile(JSON.parse(content));
    return { path, present: true, servers: parsed.mcpServers };
  } catch (error) {
    return { path, present: true, servers: {}, error: `工作区 MCP 配置无效 ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function expandEnvTemplate(value: string, env: NodeJS.ProcessEnv, context: string): string {
  return value.replace(envPattern, (_match, variable: string) => {
    const resolved = env[variable];
    requireThat(resolved !== undefined, `${context} 引用的环境变量 ${variable} 未设置。`);
    return resolved;
  });
}

export function resolveWorkspaceMcpServer(
  root: string,
  name: string,
  server: WorkspaceMcpServer,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkspaceMcpServer {
  const timeout = server.timeout ?? defaultTimeoutSeconds;
  if (isWorkspaceMcpHttpServer(server)) {
    const url = expandEnvTemplate(server.url, env, `MCP 服务 "${name}" 的 url`);
    requireThat(/^https?:\/\/.+/.test(url), `MCP 服务 "${name}" 展开后的 url 必须以 http:// 或 https:// 开头。`);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      headers[key] = expandEnvTemplate(value, env, `MCP 服务 "${name}" 的 headers.${key}`);
    }
    return {
      transport: "http",
      name,
      url,
      headers,
      ...(server.description ? { description: server.description } : {}),
      timeout,
    };
  }

  const command = expandEnvTemplate(server.command, env, `MCP 服务 "${name}" 的 command`);
  const args = (server.args ?? []).map((arg, index) => expandEnvTemplate(arg, env, `MCP 服务 "${name}" 的 args[${index}]`));
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env ?? {})) {
    resolvedEnv[key] = expandEnvTemplate(value, env, `MCP 服务 "${name}" 的 env.${key}`);
  }
  const cwd = server.cwd ? resolve(root, expandEnvTemplate(server.cwd, env, `MCP 服务 "${name}" 的 cwd`)) : root;
  return {
    transport: "stdio",
    name,
    command,
    args,
    env: resolvedEnv,
    cwd,
    ...(server.description ? { description: server.description } : {}),
    timeout,
  };
}

export function resolveWorkspaceMcpServers(
  root: string,
  configuration: WorkspaceMcpConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkspaceMcpServer[] {
  if (configuration.error) throw new Error(configuration.error);
  const resolved: ResolvedWorkspaceMcpServer[] = [];
  for (const [name, server] of Object.entries(configuration.servers)) {
    if (server.enabled === false) continue;
    resolved.push(resolveWorkspaceMcpServer(root, name, server, env));
  }
  return resolved;
}

export async function upsertWorkspaceMcpServer(
  root: string,
  name: string,
  server: WorkspaceMcpServer,
): Promise<WorkspaceMcpConfiguration> {
  const validated = validateWorkspaceMcpServer(name, server);
  const current = await readWorkspaceMcpConfig(root);
  if (current.error) throw new Error(current.error);
  const directory = dirname(current.path);
  await mkdir(directory, { recursive: true });
  const existing = current.present ? readJsonFile(directory, "mcp.json", validateMcpFile) : { mcpServers: {} };
  const next: WorkspaceMcpConfig = { mcpServers: { ...existing.mcpServers, [name]: validated } };
  const written = writeJsonFile(directory, "mcp.json", next, validateMcpFile, !current.present);
  if (!written) return upsertWorkspaceMcpServer(root, name, server);
  return readWorkspaceMcpConfig(root);
}

export async function removeWorkspaceMcpServer(
  root: string,
  name: string,
): Promise<{ removed: boolean; configuration: WorkspaceMcpConfiguration }> {
  const current = await readWorkspaceMcpConfig(root);
  if (current.error) throw new Error(current.error);
  if (!current.present || !Object.hasOwn(current.servers, name)) {
    return { removed: false, configuration: current };
  }
  const directory = dirname(current.path);
  const existing = readJsonFile(directory, "mcp.json", validateMcpFile);
  if (!Object.hasOwn(existing.mcpServers, name)) {
    return { removed: false, configuration: await readWorkspaceMcpConfig(root) };
  }
  const remaining = Object.fromEntries(Object.entries(existing.mcpServers).filter(([key]) => key !== name));
  writeJsonFile(directory, "mcp.json", { mcpServers: remaining }, validateMcpFile);
  return { removed: true, configuration: await readWorkspaceMcpConfig(root) };
}
