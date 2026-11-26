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
export interface AgentMessage { requestId: string; generation: string; sequence: number; message: string; delivery: "steer" | "followUp"; files: string[] }
export interface AgentCycle {
  cycleId: string; generation: string; startedAt: number; finishedAt?: number;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  leaf: string | null; requestIds: string[]; source: "parent" | "interactive" | "mixed";
  error?: string;
}
export interface AgentStatus {
  generation: string; state: "starting" | "busy" | "idle" | "stopping" | "stopped" | "error";
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
