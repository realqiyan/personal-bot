import type { AcpCommands } from "./acp.js";

export interface WorkspaceFeatures {
  prompts?: boolean;
  skills?: boolean;
  mcp?: boolean;
  history?: boolean;
}

export type ResolvedWorkspaceFeatures = Readonly<Required<WorkspaceFeatures>>;

export const summaryConcurrency = { default: 3, max: 8 } as const;

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

export const historyLayouts = ["monthly", "flat"] as const;
export type HistoryLayout = typeof historyLayouts[number];

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

export interface WorkspaceConfiguration extends WorkspaceConfig {
  path: string;
  present: boolean;
  enabled: boolean;
  error?: string;
}
