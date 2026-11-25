export type KnownHostId = "pi" | "dsh" | "claude" | "antigravity";
export type HostId = string;
export type PluginHostId = "claude" | "antigravity";
export type WorkspaceRole = "coordinator" | "general-purpose";

export interface WorkspaceEnvironment {
  host: HostId;
  workspaceRoot: string;
  resourceRoot: string;
}

export interface WorkspaceContext {
  workspace: string;
  role: string;
  rootAgents: string;
  environment: WorkspaceEnvironment;
  text: string;
}

export type HostEvent =
  | { kind: "ignore" }
  | { kind: "inject-context"; role: WorkspaceRole; localRoleOnly?: boolean; cwd: string; raw: unknown }
  | { kind: "check-skill"; skill: string; cwd: string; raw: unknown }
  | { kind: "subagent-call"; prompt: string; cwd: string; raw: unknown };

export interface PluginHostAdapter {
  readonly host: PluginHostId;
  readonly nativeRootAgents: boolean;
  readonly initCommandHint: string;
  readonly usage: string;
  resolveRoot(cwd: string, rawPayload?: unknown): Promise<string>;
  parseEvent(payload: unknown): HostEvent;
  formatPass(payload: unknown): Record<string, unknown>;
  formatContext(event: Extract<HostEvent, { kind: "inject-context" }>, context: WorkspaceContext): Record<string, unknown>;
  formatDeny(event: Extract<HostEvent, { kind: "check-skill" }>, reason: string): Record<string, unknown>;
  formatSubagentCall?(event: Extract<HostEvent, { kind: "subagent-call" }>, supplement: string): Record<string, unknown>;
}
