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
