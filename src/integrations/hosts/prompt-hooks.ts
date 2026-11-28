import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import type { HostEvent, PluginHostAdapter } from "../../model/plugin-host.js";

/** Shared stdin/stdout contract for hosts with Claude-compatible prompt and stop hooks. */
export async function pluginWorkspaceRoot(directory: string): Promise<string> {
  requireThat(isAbsolute(directory), "插件工作区需要绝对路径。");
  const root = await realpath(directory);
  requireThat((await stat(root)).isDirectory(), "插件工作区需要目录。");
  return root;
}

export function parsePromptEvent(value: unknown): HostEvent {
  requireThat(object(value), "插件 hook 输入无效。");
  const name = value.hook_event_name;
  if (name !== "Stop" && name !== "UserPromptSubmit" && name !== "SessionStart") return { kind: "ignore" };
  if (typeof value.agent_id === "string") return { kind: "ignore" };
  requireThat(typeof value.cwd === "string", "插件 hook 缺少工作目录。");
  if (name === "Stop") return { kind: "record-history", cwd: value.cwd, raw: value };
  if (name === "SessionStart") {
    if (value.source === "resume" || value.source === "compact") return { kind: "ignore" };
    return { kind: "inject-context", role: "coordinator", isSessionStart: true, noticesOnly: true, cwd: value.cwd, raw: value };
  }
  return { kind: "inject-context", role: "coordinator", cwd: value.cwd, raw: value };
}

export const promptHooks = {
  async extractHistory(event) {
    if (!object(event.raw)) return undefined;
    const sessionId = typeof event.raw.session_id === "string" ? event.raw.session_id.trim() : "";
    if (!sessionId) return undefined;
    const turnId = typeof event.raw.turn_id === "string" ? event.raw.turn_id.trim() : "";
    const identity = turnId ? { sessionId, turnId } : { sessionId };
    if (event.raw.hook_event_name === "UserPromptSubmit") {
      const text = typeof event.raw.prompt === "string" ? event.raw.prompt.trim() : "";
      if (!text && !turnId) return undefined;
      return { kind: "input", ...identity, text };
    }
    if (event.raw.hook_event_name === "Stop") {
      const assistantText = typeof event.raw.last_assistant_message === "string" ? event.raw.last_assistant_message.trim() : "";
      if (!assistantText) return undefined;
      return {
        kind: "answer",
        ...identity,
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
} satisfies Pick<PluginHostAdapter, "extractHistory" | "formatPass" | "formatContext" | "formatDeny">;
