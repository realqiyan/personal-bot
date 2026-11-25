export type BuiltinAcpBackend = "pi" | "dsh" | "claude" | "antigravity" | "codex";
export type AcpBackend = string;
export interface AcpCommand { command: string; args: string[] }
export type AcpCommands = Record<string, AcpCommand>;
export interface AcpSessionReference extends AcpCommand {
  host: "acp";
  backend: AcpBackend;
  sessionId: string | null;
  capabilities?: { resume: boolean; load: boolean; close: boolean };
}
export interface AcpModelSelection { provider?: string; model?: string; resolvedModel?: string; thinking?: string }
export interface AcpModelState extends AcpModelSelection { generation: string }
export interface AcpProcess { generation: string; pid: number; startedAt: number }
export interface AcpInput { generation: string; requestId: string }
export interface AcpAnswer extends AcpInput {
  answer: string;
  state: "completed" | "failed" | "cancelled";
  error?: string;
}
export interface AcpReport { generation: string; cycleId: string; text: string }
export interface AcpPermission {
  generation: string;
  requestId: string;
  description: string;
  options: { optionId: string; name: string; kind: string }[];
}
export interface AcpPermissionReply { generation: string; requestId: string; optionId: string | null }
