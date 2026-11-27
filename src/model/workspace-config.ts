import type { AcpCommands } from "./acp.js";

export interface WorkspaceFeatures {
  prompts?: boolean;
  skills?: boolean;
  mcp?: boolean;
  history?: boolean;
}

export interface ResolvedWorkspaceFeatures {
  readonly prompts: boolean;
  readonly skills: boolean;
  readonly mcp: boolean;
  readonly history: boolean;
}

export interface WorkspaceSummaryConfig {
  backend?: string;
  model?: string;
  thinking?: string;
  concurrency?: number;
}

export interface ResolvedWorkspaceSummaryConfig {
  readonly backend: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly concurrency: number;
}

export type HistoryLayout = "monthly" | "flat";

export interface WorkspaceHistoryConfig {
  layout?: HistoryLayout;
}

export interface ResolvedWorkspaceHistoryConfig {
  readonly layout: HistoryLayout;
}

export interface WorkspaceConfig {
  enabled?: boolean;
  features?: WorkspaceFeatures;
  acp?: AcpCommands;
  summary?: WorkspaceSummaryConfig;
  history?: WorkspaceHistoryConfig;
}

export interface WorkspaceConfiguration {
  path: string;
  present: boolean;
  enabled: boolean;
  error?: string;
  features?: WorkspaceFeatures;
  acp?: AcpCommands;
  summary?: WorkspaceSummaryConfig;
  history?: WorkspaceHistoryConfig;
}
