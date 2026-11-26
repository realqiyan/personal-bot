import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import type { ResolvedWorkspaceMcpServer } from "../../model/workspace-mcp.js";

/** Translate a resolved workspace MCP entry into dsh's native `@deepseek-ai/dsh-mcp-client` config. */
export function toDshMcpConfig(server: ResolvedWorkspaceMcpServer): McpClient.Config {
  if (server.transport === "http") {
    return McpClient.Config({
      transport: "streamable-http",
      serverName: server.name,
      url: server.url,
      headers: { ...server.headers },
      toolCallTimeoutMs: server.timeout * 1000,
      failOnStartupError: false,
    });
  }
  return McpClient.Config({
    transport: "stdio",
    serverName: server.name,
    command: server.command,
    args: [...server.args],
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...server.env,
    },
    cwd: server.cwd,
    toolCallTimeoutMs: server.timeout * 1000,
    failOnStartupError: false,
  });
}
