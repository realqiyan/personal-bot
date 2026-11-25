import type { AcpBackend, AcpModelSelection, AcpSessionReference, AcpStartOptions } from "./acp.js";

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
  pendingPermissions?: AgentPermissionRequest[];
}
export interface AgentPermissionRequest { permissionId: string; description: string; options: { optionId: string; name: string; kind: string }[] }
export interface AgentCompletion { agentId: string; name: string; cycle: AgentCycle; report: string }
