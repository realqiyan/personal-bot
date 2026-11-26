import { requireThat } from "../../../common/validation.js";
import type { AcpBackend, AcpCommand, AcpHarnessAdapter, AcpLaunchContext, AcpPreparedLaunch, AcpStartOptions } from "../../../model/acp.js";

const piOnlyOptions = ["noExtensions", "noPromptTemplates", "noContextFiles"] as const;

export function filterStandardAcpOptions(options: AcpStartOptions): AcpStartOptions {
  const result: AcpStartOptions = { ...options };
  for (const key of piOnlyOptions) delete result[key];
  delete result.noSkills;
  delete result.tools;
  return result;
}

export function validateStandardAcpOptions(backend: AcpBackend, options: AcpStartOptions): void {
  for (const key of piOnlyOptions) {
    requireThat(options[key] === undefined, backend + " 子代理不支持启动选项：" + key);
  }
}

export function defaultPrepareLaunch(context: AcpLaunchContext): AcpPreparedLaunch {
  return {
    command: { ...context.reference, args: [...context.reference.args] },
    env: { ...context.env, ...(context.reference.env ?? {}) },
  };
}

/** Generic ACP v1 harness adapter; works for any standard ACP v1 executable without special cases. */
export function createGenericAcpHarness(
  id: AcpBackend,
  preset: {
    label?: string;
    aliases?: readonly string[];
    defaultCommand?: AcpCommand;
    installHint?: string;
    configureHint?: string;
    nativeWorkspaceSkills?: boolean;
  } = {},
): AcpHarnessAdapter {
  return {
    id,
    ...(preset.label ? { label: preset.label } : {}),
    ...(preset.aliases ? { aliases: preset.aliases } : {}),
    ...(preset.defaultCommand ? { defaultCommand: preset.defaultCommand } : {}),
    ...(preset.installHint ? { installHint: preset.installHint } : {}),
    ...(preset.configureHint ? { configureHint: preset.configureHint } : {}),
    ...(preset.nativeWorkspaceSkills !== undefined ? { nativeWorkspaceSkills: preset.nativeWorkspaceSkills } : {}),
    filterStartOptions: filterStandardAcpOptions,
    validateStartOptions: options => validateStandardAcpOptions(id, options),
    prepareLaunch: defaultPrepareLaunch,
    parseModelValue: value => ({ model: value }),
  };
}
