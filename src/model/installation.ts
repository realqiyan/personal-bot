export interface PluginSpec {
  id: string;
  label: string;
  description: string;
  source: string;
  defaultSelected: boolean;
}
export interface InstalledPackage {
  source: string;
  scope: "user" | "project";
  name?: string;
  version?: string;
  installedPath?: string;
  filtered: boolean;
  entry: unknown;
}
export interface PackageChoice {
  plugin: PluginSpec;
  required: boolean;
  existing: InstalledPackage[];
  selected: boolean;
  keep: boolean;
  target?: string;
  error?: string;
}
export interface PiInstallation { command: string; root: string; version: string }
export interface SystemCommand { command: string; args: string[] }
export interface SetupPlan {
  workspace: string;
  pi?: PiInstallation;
  piVersion: string;
  tmux?: SystemCommand;
  packages: PackageChoice[];
}
export interface SetupResult { name: string; state: "done" | "kept" | "skipped" | "failed"; detail: string }
export interface SetupOperations {
  installTmux(command: SystemCommand): Promise<void>;
  ensurePi(existing: PiInstallation | undefined, version: string): Promise<PiInstallation>;
  installPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string>;
  verifyKeptPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string>;
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
