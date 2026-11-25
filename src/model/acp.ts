export type AcpBackend = string;
export interface AcpCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
/** ask: forward target permission requests to the parent session; allow/deny: answer them automatically. */
export type AcpPermissionPolicy = "ask" | "allow" | "deny";
/** Workspace `acp.<name>` entry; omitting `command` keeps a registered harness's default command. */
export interface AcpHarnessConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  permission?: AcpPermissionPolicy;
}
export type AcpCommands = Record<string, AcpHarnessConfig>;
export interface AcpSessionReference extends AcpCommand {
  host: "acp";
  backend: AcpBackend;
  sessionId: string | null;
  permission?: AcpPermissionPolicy;
  capabilities?: { resume: boolean; load: boolean; close: boolean };
}
export interface AcpModelSelection { provider?: string; model?: string; resolvedModel?: string; thinking?: string }
export interface AcpChoice { value: string; name: string; description?: string }
export interface AcpModelsResult {
  backend: AcpBackend;
  models: AcpChoice[];
  thinking: AcpChoice[];
  currentModel?: string;
  currentThinking?: string;
  selection: AcpModelSelection;
}
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
  /** Product name users say in conversation, e.g. "Claude Code". */
  readonly label?: string;
  /** Alternative backend names accepted from callers; configured custom names take precedence. */
  readonly aliases?: readonly string[];
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
