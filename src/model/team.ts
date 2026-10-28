import type { AgentOwner, AgentView } from "./agent.js";

export interface TeamRequest {
  requestId: string; agentId: string; generation: string; round: number; throughSeq: number;
}
export interface TeamRun {
  runId: string; instruction: string; mode: "roundRobin" | "parallel"; rounds: number;
  maxConcurrent: number; deadlineAt: number; generations: Record<string, string>;
  state: "running" | "paused" | "finished"; reason?: string; issued: TeamRequest[];
}
export interface TeamMessage {
  seq: number; operationId: string;
  author: { kind: "user" | "coordinator" | "member"; agentId?: string; name: string };
  text: string; replyTo?: number; runId?: string; source?: { requestId: string; cycleId: string };
}
export interface TeamRecord {
  teamId: string; release: string; workspace: string; parentSessionId: string; parentLeaf: string | null;
  name: string; brief: string; closed: boolean; members: { agentId: string; role: string }[];
  runs: TeamRun[]; messages: TeamMessage[];
}
export interface TeamReady { generation: string; ready: boolean }
export type TeamAgent = AgentView & { alive: boolean };
export type TeamActor = { kind: "user" | "coordinator"; owner: AgentOwner }
  | { kind: "member"; agentId: string; generation: string; requestId?: string };
export interface TeamInput extends TeamRequest { teamId: string; runId: string; message: string }
export interface TeamLink { team: TeamRecord; run: TeamRun; request: TeamRequest }
export interface TeamRunOptions {
  instruction: string; mode: TeamRun["mode"]; rounds?: number; maxConcurrent?: number; timeoutSeconds?: number;
}
