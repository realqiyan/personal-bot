import { object } from "../../../common/json.js";
import { requireThat } from "../../../common/validation.js";
import type { HostEvent, PluginHostAdapter } from "../../../model/plugin-host.js";
import { parsePromptEvent, pluginWorkspaceRoot, promptHooks } from "../prompt-hooks.js";

const supportedEvents = ["UserPromptSubmit", "PreToolUse", "UserPromptExpansion", "Stop"];
const boundWorkspaceRoot = () => process.env.CLAUDE_PROJECT_DIR;

export async function claudeWorkspaceRoot(cwd: string, projectDirectory = boundWorkspaceRoot()): Promise<string> {
  return pluginWorkspaceRoot(projectDirectory || cwd);
}

export const claudeAdapter: PluginHostAdapter = {
  host: "claude",
  nativeRootAgents: false,
  nativeWorkspaceSkills: false,
  coordinatorPrompt: "plugin-coordinator.md",
  initCommandHint: "/personal-bot:pbot init",
  usage: "用法：node <插件目录>/lib/claude.js init|status",
  boundWorkspaceRoot,
  resolveRoot(cwd) {
    return claudeWorkspaceRoot(cwd);
  },
  parseEvent(value): HostEvent {
    requireThat(object(value) && typeof value.hook_event_name === "string", "Claude hook 输入无效。");
    const event = value.hook_event_name;
    requireThat(supportedEvents.includes(event), "Claude hook 事件未支持。");
    if (event === "PreToolUse" || event === "UserPromptExpansion") {
      const skill = event === "UserPromptExpansion"
        ? value.expansion_type === "slash_command" ? value.command_name : undefined
        : value.tool_name === "Skill" && object(value.tool_input) ? value.tool_input.skill : undefined;
      if (typeof skill !== "string" || !skill.startsWith("personal-bot:") || skill === "personal-bot:pbot") return { kind: "ignore" };
      requireThat(typeof value.cwd === "string", "Claude hook 缺少工作目录。");
      return { kind: "check-skill", skill, cwd: value.cwd, raw: value };
    }
    return parsePromptEvent(value);
  },
  ...promptHooks,
};
