import type { WorkspaceConfiguration } from "../../model/workspace-config.js";

export type CliUpdatePolicy = "none" | "workspace" | "hook";

export interface CliContext {
  readonly verb: string;
  readonly rawArgs: readonly string[];
  readonly args: string[];
  readonly workspace?: string;
  readonly json: boolean;
  readonly cwd: string;
}

export interface CliCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly updatePolicy: CliUpdatePolicy | ((ctx: CliContext) => CliUpdatePolicy);
  readonly supportsWorkspaceFlag?: boolean;
  readonly supportsJsonFlag?: boolean;
  readonly resolveWorkspaceRoot?: (ctx: CliContext) => Promise<string>;
  readonly allowUninitializedUpdate?: (ctx: CliContext) => boolean;
  readonly beforeUpdate?: (ctx: CliContext, root: string, configuration: WorkspaceConfiguration) => void;
  readonly run: (ctx: CliContext, helpers: CliRuntimeHelpers) => Promise<number>;
}

export interface CliRuntimeHelpers {
  readonly updateForWorkspace: (root: string, args: readonly string[], input?: string) => Promise<number | undefined>;
}
