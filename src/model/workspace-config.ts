import type { AcpCommands } from "./acp.js";

export interface WorkspaceConfig {
  enabled?: boolean;
  acp?: AcpCommands;
}

export interface WorkspaceConfiguration {
  path: string;
  present: boolean;
  enabled: boolean;
  error?: string;
  acp?: AcpCommands;
}
