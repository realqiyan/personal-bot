export type HostInstallState = "installed" | "skipped" | "failed";

export interface HostInstallContext {
  workspace: string;
  packageRoot: string;
  explicit: boolean;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  options: Readonly<Record<string, string | undefined>>;
  run(command: string, args: string[], cwd: string, options?: { interactive?: boolean; timeoutMs?: number }): Promise<string>;
  findExecutable(name: string): Promise<string | undefined>;
}

export interface HostInstallResult {
  host: string;
  state: HostInstallState;
  version?: string;
  scope?: string;
  detail: string;
  nextStep?: string;
}

export interface HostInstaller {
  readonly host: string;
  install(context: HostInstallContext): Promise<HostInstallResult>;
}

export interface WorkspaceInstallSummary {
  workspaceRoot: string;
  target: string;
  results: HostInstallResult[];
  ok: boolean;
}

export type HostUpgradeState = "updated" | "up-to-date" | "skipped" | "failed";

export interface HostUpgradeContext {
  workspace: string;
  targetVersion: string;
  currentVersion?: string;
  packageRoot: string;
  bindingPath?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  options: Readonly<Record<string, string | undefined>>;
  run(command: string, args: string[], cwd: string, options?: { interactive?: boolean; timeoutMs?: number }): Promise<string>;
  findExecutable(name: string): Promise<string | undefined>;
}

export interface HostUpgradeResult {
  host: string;
  state: HostUpgradeState;
  previousVersion?: string;
  version?: string;
  scope?: string;
  detail: string;
  nextStep?: string;
}

export interface HostUpgrader {
  readonly host: string;
  upgrade(context: HostUpgradeContext): Promise<HostUpgradeResult>;
}

export interface CliUpgradeSummary {
  state: HostUpgradeState;
  previousVersion: string;
  version: string;
  detail: string;
}

export interface WorkspaceUpgradeSummary {
  workspaceRoot: string;
  targetVersion: string;
  cli: CliUpgradeSummary;
  results: HostUpgradeResult[];
  ok: boolean;
}
