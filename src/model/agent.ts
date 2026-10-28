export interface AgentOptions {
  name?: string; message?: string; files?: string[]; prompts?: string[];
  provider?: string; model?: string; thinking?: string; cwd?: string; tools?: string[];
  noExtensions?: boolean; noSkills?: boolean; noPromptTemplates?: boolean; noContextFiles?: boolean;
}
export interface AgentOwner { sessionId: string; leaf: string | null; branch: string[] }
export interface AgentDescriptor {
  agentId: string; release: string; workspace: string; cwd: string; parentSessionId: string;
  parentLeaf: string | null; createdAt: number; options: AgentOptions;
}
/** null means no conversation input has been handed to Pi yet. */
export interface AgentSessionRef { file: string | null }
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
  cycle?: AgentCycle; error?: string; owned: boolean;
}
export interface AgentCompletion { agentId: string; name: string; cycle: AgentCycle; report: string }
