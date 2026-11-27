import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { object } from "../../../common/json.js";
import { resourceRoot } from "../../../common/paths.js";
import { requireThat } from "../../../common/validation.js";
import type { HistoryExchange, HistorySession } from "../../../model/history.js";
import type { HostEvent, PluginHostAdapter } from "../../../model/plugin-host.js";

const supportedEvents = ["SessionStart", "PreToolUse", "Stop"];

function cleanUserRequest(content: string): string {
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1]! : content).trim();
}

export function projectAntigravityTranscript(sessionId: string, content: string, terminationReason?: string): HistorySession {
  const exchanges: HistoryExchange[] = [];
  const lines = content.split(/\r?\n/);
  let users: { id: string; text: string; time: string }[] = [];
  let answer: { id: string; text: string; time: string } | undefined;

  const finish = (completed: boolean) => {
    if (!users.length) return;
    const entryIds = [...users.map(u => u.id), ...(answer ? [answer.id] : [])];
    const from = users[0]!.time;
    const to = answer?.time ?? users.at(-1)!.time;
    const text = users.map(u => "用户：\n" + u.text).join("\n\n") +
      (answer ? "\n\n助手：\n" + answer.text : "");
    exchanges.push({ entryIds, from, to, completed, text });
    users = [];
    answer = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!object(entry) || typeof entry.type !== "string") continue;
    const stepIndex = typeof entry.step_index === "number" ? entry.step_index : exchanges.length;
    const time = typeof entry.created_at === "string" && entry.created_at ? entry.created_at : new Date().toISOString();
    if (entry.type === "USER_INPUT" && typeof entry.content === "string") {
      if (answer) finish(true);
      const cleaned = cleanUserRequest(entry.content);
      if (cleaned) users.push({ id: `agy:${stepIndex}`, text: cleaned, time });
    } else if (entry.type === "PLANNER_RESPONSE" && users.length) {
      const hasToolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (!hasToolCalls && text) {
        answer = { id: `agy:${stepIndex}`, text, time };
      }
    }
  }
  const completed = Boolean(answer) && (!terminationReason || terminationReason === "NO_TOOL_CALL");
  finish(completed);
  return { sessionId, name: "", branches: exchanges.length ? [exchanges] : [] };
}

async function readAntigravityTranscript(transcriptPath: string): Promise<string | undefined> {
  const fullPath = join(dirname(transcriptPath), "transcript_full.jsonl");
  for (const path of [fullPath, transcriptPath]) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}

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
  nativeWorkspaceSkills: true,
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
      return { kind: "inject-context", role: "coordinator", isSessionStart: true, cwd, raw: value };
    }
    if (event === "Stop") {
      return { kind: "record-history", cwd, raw: value };
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
  async extractHistory(event) {
    if (event.kind !== "record-history" || !object(event.raw)) return undefined;
    const sessionId = typeof event.raw.conversationId === "string" ? event.raw.conversationId.trim() : "";
    if (!sessionId) return undefined;
    const terminationReason = typeof event.raw.terminationReason === "string" ? event.raw.terminationReason : undefined;
    const transcriptPath = typeof event.raw.transcriptPath === "string" ? event.raw.transcriptPath.trim() : "";
    if (transcriptPath) {
      const content = await readAntigravityTranscript(transcriptPath);
      if (content) {
        const session = projectAntigravityTranscript(sessionId, content, terminationReason);
        if (session.branches.length) return { kind: "session", session };
      }
    }
    const lastUserInput = typeof event.raw.lastUserInput === "string" ? event.raw.lastUserInput.trim() : "";
    if (lastUserInput) return { kind: "input", sessionId, text: lastUserInput };
    return undefined;
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
