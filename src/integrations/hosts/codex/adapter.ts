import type { PluginHostAdapter } from "../../../model/plugin-host.js";
import { parsePromptEvent, pluginWorkspaceRoot, promptHooks } from "../prompt-hooks.js";

export const codexAdapter: PluginHostAdapter = {
  host: "codex",
  nativeRootAgents: true,
  nativeWorkspaceSkills: true,
  indexBundledSkills: true,
  initCommandHint: "pbot plugin codex init",
  usage: "用法：pbot plugin codex init|status",
  resolveRoot(cwd) {
    return pluginWorkspaceRoot(cwd);
  },
  parseEvent: parsePromptEvent,
  ...promptHooks,
};
