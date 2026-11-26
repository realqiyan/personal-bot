import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { ResolvedWorkspaceMcpServer } from "../../model/workspace-mcp.js";

/** Translate a resolved workspace MCP entry into Pi's native `registerMcpServer` config. */
export function toPiMcpConfig(server: ResolvedWorkspaceMcpServer): McpServerConfig {
  if (server.transport === "http") {
    return {
      type: "http",
      url: server.url,
      ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}),
      exposure: "direct",
      timeout: server.timeout,
      ...(server.description ? { description: server.description } : {}),
    };
  }
  return {
    type: "stdio",
    command: server.command,
    args: [...server.args],
    ...(Object.keys(server.env).length ? { env: { ...server.env } } : {}),
    cwd: server.cwd,
    exposure: "direct",
    timeout: server.timeout,
    ...(server.description ? { description: server.description } : {}),
  };
}
