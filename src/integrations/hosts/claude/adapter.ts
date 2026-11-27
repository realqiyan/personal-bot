import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { object } from "../../../common/json.js";
import { requireThat } from "../../../common/validation.js";
import type { HostEvent, PluginHostAdapter } from "../../../model/plugin-host.js";

const supportedEvents = ["UserPromptSubmit", "PreToolUse", "UserPromptExpansion", "Stop"];

export async function claudeWorkspaceRoot(cwd: string, projectDirectory = process.env.CLAUDE_PROJECT_DIR): Promise<string> {
  const directory = projectDirectory || cwd;
  requireThat(isAbsolute(directory), "Claude 工作区需要绝对路径。");
  const root = await realpath(directory);
  requireThat((await stat(root)).isDirectory(), "Claude 工作区需要目录。");
  return root;
}

export const claudeAdapter: PluginHostAdapter = {
  host: "claude",
  nativeRootAgents: false,
  nativeWorkspaceSkills: false,
  coordinatorPrompt: "plugin-coordinator.md",
  initCommandHint: "/personal-bot:pbot init",
  usage: "用法：node <插件目录>/lib/claude.js init|status",
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
    // Leave Claude's native subagents untouched; only inject coordinator context or record history in main sessions.
    if (typeof value.agent_id === "string") return { kind: "ignore" };
    requireThat(typeof value.cwd === "string", "Claude hook 缺少工作目录。");
    if (event === "Stop") return { kind: "record-history", cwd: value.cwd, raw: value };
    return { kind: "inject-context", role: "coordinator", cwd: value.cwd, raw: value };
  },
  async extractHistory(event) {
    if (!object(event.raw)) return undefined;
    const sessionId = typeof event.raw.session_id === "string" ? event.raw.session_id.trim() : "";
    if (!sessionId) return undefined;
    if (event.raw.hook_event_name === "UserPromptSubmit") {
      const text = typeof event.raw.prompt === "string" ? event.raw.prompt.trim() : "";
      if (!text) return undefined;
      return { kind: "input", sessionId, text };
    }
    if (event.raw.hook_event_name === "Stop") {
      const assistantText = typeof event.raw.last_assistant_message === "string" ? event.raw.last_assistant_message.trim() : "";
      if (!assistantText) return undefined;
      return {
        kind: "answer",
        sessionId,
        assistantText,
        completed: true,
        ...(event.raw.stop_hook_active === true ? { isContinuation: true } : {}),
      };
    }
    return undefined;
  },
  formatPass() {
    return {};
  },
  formatContext(event, context) {
    const raw = event.raw as { hook_event_name: string };
    return {
      hookSpecificOutput: {
        hookEventName: raw.hook_event_name,
        additionalContext: context.text,
      },
    };
  },
  formatDeny(event, reason) {
    const raw = event.raw as { hook_event_name: string };
    return raw.hook_event_name === "UserPromptExpansion"
      ? { decision: "block", reason }
      : { hookSpecificOutput: { hookEventName: raw.hook_event_name, permissionDecision: "deny", permissionDecisionReason: reason } };
  },
};
