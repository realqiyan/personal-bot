import type { PluginHostAdapter } from "../../../model/plugin-host.js";
import { parsePromptEvent, pluginWorkspaceRoot, promptHooks } from "../prompt-hooks.js";

const boundWorkspaceRoot = () => process.env.QODER_PROJECT_DIR || process.env.PBOT_WORKSPACE_ROOT;

export const qoderAdapter: PluginHostAdapter = {
  host: "qoder",
  nativeRootAgents: true,
  nativeWorkspaceSkills: true,
  indexBundledSkills: true,
  initCommandHint: "pbot plugin qoder init",
  usage: "用法：pbot plugin qoder init|status",
  boundWorkspaceRoot,
  resolveRoot(cwd) {
    return pluginWorkspaceRoot(boundWorkspaceRoot() || cwd);
  },
  parseEvent: parsePromptEvent,
  ...promptHooks,
};
