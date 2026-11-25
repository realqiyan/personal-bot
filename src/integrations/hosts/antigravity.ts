import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { object } from "../../common/json.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import type { HostEvent, PluginHostAdapter } from "../../model/plugin-host.js";

const supportedEvents = ["SessionStart", "PreToolUse"];

function workspaceFromPayload(cwd: string, payload?: unknown): string {
  if (object(payload) && Array.isArray(payload.workspacePaths)) {
    const first = payload.workspacePaths.find(value => typeof value === "string" && value.length > 0);
    if (typeof first === "string") return first;
  }
  return cwd;
}

function skillFromReadPath(targetPath: string, pluginRoot = process.env.PLUGIN_ROOT || resolve(resourceRoot, "..")): string | undefined {
  const skillsRoot = resolve(pluginRoot, "skills");
  const rel = relative(skillsRoot, resolve(targetPath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const skill = rel.split(sep)[0];
  if (!skill || skill === "pbot") return undefined;
  return skill;
}

function isPreToolUse(payload: unknown): boolean {
  return object(payload) && payload.hookEventName === "PreToolUse";
}

export async function antigravityWorkspaceRoot(cwd: string, payload?: unknown): Promise<string> {
  const directory = workspaceFromPayload(cwd, payload);
  requireThat(isAbsolute(directory), "Antigravity 工作区需要绝对路径。");
  const root = await realpath(directory);
  requireThat((await stat(root)).isDirectory(), "Antigravity 工作区需要目录。");
  return root;
}

export const antigravityAdapter: PluginHostAdapter = {
  host: "antigravity",
  nativeRootAgents: true,
  coordinatorPrompt: "plugin-coordinator.md",
  initCommandHint: "/pbot init",
  usage: "用法：node <插件目录>/lib/plugin.js antigravity init|status",
  resolveRoot(cwd, rawPayload) {
    return antigravityWorkspaceRoot(cwd, rawPayload);
  },
  parseEvent(value): HostEvent {
    requireThat(object(value) && typeof value.hookEventName === "string", "Antigravity hook 输入无效。");
    const event = value.hookEventName;
    requireThat(supportedEvents.includes(event), "Antigravity hook 事件未支持。");
    const cwd = typeof value.cwd === "string" && value.cwd ? value.cwd : workspaceFromPayload("", value);
    requireThat(cwd, "Antigravity hook 缺少工作目录。");
    if (event === "SessionStart") {
      return { kind: "inject-context", role: "coordinator", cwd, raw: value };
    }
    if (!object(value.toolCall) || typeof value.toolCall.name !== "string" || !object(value.toolCall.args)) {
      return { kind: "ignore" };
    }
    const { name, args } = value.toolCall;
    if (name === "read_file" && typeof args.Path === "string") {
      const skill = skillFromReadPath(args.Path);
      if (skill) return { kind: "check-skill", skill, cwd, raw: value };
    }
    return { kind: "ignore" };
  },
  formatPass(payload) {
    return isPreToolUse(payload) ? { decision: "allow" } : {};
  },
  formatContext(_event, context) {
    return {
      injectSteps: [
        { systemMessage: { systemMessage: context.text } },
      ],
    };
  },
  formatDeny(_event, reason) {
    return { decision: "deny", reason };
  },
};

export const antigravitySkillPath = (pluginRoot: string, skill: string) => join(pluginRoot, "skills", skill, "SKILL.md");
