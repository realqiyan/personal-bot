export const workspaceMcpToolNames = [
  "workspace_mcp_discover",
  "workspace_mcp_call",
] as const;
export type WorkspaceMcpToolName = typeof workspaceMcpToolNames[number];

export interface WorkspaceMcpServerBase {
  description?: string;
  timeout?: number;
  enabled?: boolean;
}

export interface WorkspaceMcpStdioServer extends WorkspaceMcpServerBase {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface WorkspaceMcpHttpServer extends WorkspaceMcpServerBase {
  url: string;
  headers?: Record<string, string>;
}

export type WorkspaceMcpServer = WorkspaceMcpStdioServer | WorkspaceMcpHttpServer;

export interface WorkspaceMcpConfig {
  mcpServers: Record<string, WorkspaceMcpServer>;
}

export interface WorkspaceMcpConfiguration {
  path: string;
  present: boolean;
  servers: Record<string, WorkspaceMcpServer>;
  error?: string;
}

export interface ResolvedWorkspaceMcpStdioServer {
  readonly transport: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly description?: string;
  readonly timeout: number;
}

export interface ResolvedWorkspaceMcpHttpServer {
  readonly transport: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly description?: string;
  readonly timeout: number;
}

export type ResolvedWorkspaceMcpServer = ResolvedWorkspaceMcpStdioServer | ResolvedWorkspaceMcpHttpServer;

export interface WorkspaceSkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}
