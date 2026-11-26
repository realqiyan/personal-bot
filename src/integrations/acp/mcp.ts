import { isAbsolute, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { ResolvedWorkspaceMcpServer } from "../../model/workspace-mcp.js";
import { findAcpExecutable } from "./executable.js";

function resolveStdioCommand(command: string, cwd: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return resolve(cwd, command);
  return findAcpExecutable(command) ?? command;
}

/** Convert resolved workspace MCP entries into ACP v1 `McpServer` descriptors. */
export function toAcpMcpServers(servers: readonly ResolvedWorkspaceMcpServer[]): acp.McpServer[] {
  return servers.map(server => {
    if (server.transport === "http") {
      return {
        type: "http" as const,
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
      };
    }
    return {
      name: server.name,
      command: resolveStdioCommand(server.command, server.cwd),
      args: [...server.args],
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    };
  });
}

/** Filter ACP MCP servers to the transports advertised by the peer's `mcpCapabilities`. */
export function filterAcpMcpServers(
  servers: readonly acp.McpServer[],
  capabilities?: acp.McpCapabilities,
): acp.McpServer[] {
  return servers.filter(server => {
    if (!("type" in server)) return true; // stdio is baseline in ACP v1.
    if (server.type === "http") return capabilities?.http === true;
    if (server.type === "sse") return capabilities?.sse === true;
    return false;
  });
}
