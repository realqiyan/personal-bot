import type { AcpCommands } from "./acp.js";

export interface WorkspaceFeatures {
  prompts?: boolean;
  skills?: boolean;
  mcp?: boolean;
}

export interface ResolvedWorkspaceFeatures {
  readonly prompts: boolean;
  readonly skills: boolean;
  readonly mcp: boolean;
}

export interface WorkspaceConfig {
  enabled?: boolean;
  features?: WorkspaceFeatures;
  acp?: AcpCommands;
}

export interface WorkspaceConfiguration {
  path: string;
  present: boolean;
  enabled: boolean;
  error?: string;
  features?: WorkspaceFeatures;
  acp?: AcpCommands;
}
