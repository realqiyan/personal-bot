export type AcpBackend = string;
export interface AcpCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
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

export interface AcpStartOptions {
  name?: string;
  message?: string;
  files?: string[];
  provider?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  tools?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noContextFiles?: boolean;
}

export interface AcpLaunchContext {
  readonly reference: AcpSessionReference;
  readonly cwd: string;
  readonly directory: string;
  readonly packageRoot: string;
  readonly options: AcpStartOptions;
  readonly env: NodeJS.ProcessEnv;
}

export interface AcpPreparedLaunch {
  readonly command: AcpSessionReference;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionMeta?: Record<string, unknown>;
  readonly defaultThinking?: string;
}

/** Narrow adapter isolating harness-specific ACP conventions from the generic runtime. */
export interface AcpHarnessAdapter {
  readonly id: AcpBackend;
  readonly defaultCommand?: AcpCommand;
  readonly installHint?: string;
  readonly configureHint?: string;
  readonly exactAnswer?: boolean;
  readonly eagerSessionId?: boolean;
  readonly requireSystemPrompt?: boolean;
  readonly customNotificationMethod?: string;
  filterStartOptions?(options: AcpStartOptions): AcpStartOptions;
  validateStartOptions?(options: AcpStartOptions): void;
  prepareLaunch?(context: AcpLaunchContext): Promise<AcpPreparedLaunch> | AcpPreparedLaunch;
  parseModelValue?(value: string): { provider?: string; model: string };
  formatModelQuery?(model: string, provider?: string): string | undefined;
  parseCustomNotification?(params: unknown, sessionId: string): { resolvedModel?: string } | undefined;
}
