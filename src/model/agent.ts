import type { AcpBackend, AcpElicitationAction, AcpElicitationContent, AcpModelSelection, AcpSessionReference, AcpStartOptions } from "./acp.js";

export type AgentOptions = AcpStartOptions;
export interface AgentStartOptions extends AgentOptions { backend: AcpBackend }
export interface AgentOwner { sessionId: string; leaf: string | null; branch: string[] }
export interface AgentDescriptor {
  agentId: string; release: string; workspace: string; cwd: string; parentSessionId: string;
  parentLeaf: string | null; createdAt: number; options: AgentOptions;
}
export type AgentSessionReference = AcpSessionReference;
export interface AgentLaunch { generation: string; name: string; sequence: number; stop: boolean; startedAt: number }
export const messageDeliveries = ["steer", "followUp"] as const;
export const cycleStates = ["running", "completed", "failed", "cancelled", "interrupted"] as const;
export const cycleSources = ["parent", "interactive", "mixed"] as const;
export const agentStates = ["starting", "busy", "idle", "stopping", "stopped", "error"] as const;

export interface AgentMessage { requestId: string; generation: string; sequence: number; message: string; delivery: typeof messageDeliveries[number]; files: string[] }
export interface AgentCycle {
  cycleId: string; generation: string; startedAt: number; finishedAt?: number;
  state: typeof cycleStates[number];
  leaf: string | null; requestIds: string[]; source: typeof cycleSources[number];
  error?: string;
}
export interface AgentStatus {
  generation: string; state: typeof agentStates[number];
  activity: string; updatedAt: number; accepted?: string[]; cycle?: AgentCycle; error?: string;
}
export interface AgentView extends AgentDescriptor {
  name: string; generation: string; state: AgentStatus["state"]; activity: string;
  alive: boolean;
  backend: AcpBackend; transport: "acp"; selection?: AcpModelSelection;
  capabilities: { steer: boolean; resume: boolean; transcript: boolean };
  cycle?: AgentCycle; error?: string; owned: boolean;
  pendingRequests?: AgentPendingRequest[];
}
export type AgentPendingRequest =
  | { requestId: string; kind: "permission"; description: string; options: { optionId: string; name: string; kind: string }[] }
  | { requestId: string; kind: "form"; message: string; schema: Record<string, unknown> }
  | { requestId: string; kind: "url"; message: string; url: string };
export interface AgentResponseInput {
  requestId?: string;
  action: AcpElicitationAction;
  optionId?: string;
  content?: AcpElicitationContent;
}
export interface AgentCompletion { agentId: string; name: string; cycle: AgentCycle; report: string }

export interface AgentHost {
  available(backend: AcpBackend): void;
  filterOptions?(backend: AcpBackend, options: AgentOptions): AgentOptions;
  prepare(backend: AcpBackend, options: AgentOptions): AcpSessionReference;
  alive(id: string): boolean;
  validateSession(value: AgentDescriptor, reference: AgentSessionReference): void | Promise<void>;
  launch(value: AgentDescriptor, directory: string, generation: string, reference: AgentSessionReference, resume: boolean, signal: AbortSignal): void | Promise<void>;
  release(id: string, generation: string): void | Promise<void>;
  report(value: AgentDescriptor, reference: AgentSessionReference, leaf: string): string | Promise<string>;
}
