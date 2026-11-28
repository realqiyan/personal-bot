import { realpath } from "node:fs/promises";
import { gte, valid } from "semver";
import { object } from "../../../common/json.js";
import type { HostUpgradeContext, HostUpgradeResult, HostUpgrader } from "../../../model/installation.js";

interface ClaudePluginEntry {
  id: string;
  version?: string;
  scope?: string;
  projectPath?: string;
}

function parsePluginList(raw: string): ClaudePluginEntry[] {
  const parsed: unknown = JSON.parse(raw);
  const items = Array.isArray(parsed)
    ? parsed
    : object(parsed) && Array.isArray(parsed.plugins)
      ? parsed.plugins
      : [];
  const entries: ClaudePluginEntry[] = [];
  for (const item of items) {
    if (!object(item)) continue;
    const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : undefined;
    if (!id) continue;
    entries.push({
      id,
      ...(typeof item.version === "string" ? { version: item.version } : {}),
      ...(typeof item.scope === "string" ? { scope: item.scope } : {}),
      ...(typeof item.projectPath === "string" ? { projectPath: item.projectPath } : {}),
    });
  }
  return entries;
}

async function resolvePathSafe(value: string): Promise<string> {
  try { return await realpath(value); } catch { return value; }
}

async function selectMatchingEntry(entries: ClaudePluginEntry[], workspace: string): Promise<ClaudePluginEntry | undefined> {
  const canonicalWorkspace = await resolvePathSafe(workspace);
  const candidates = entries.filter(entry => entry.id === "personal-bot" || entry.id.startsWith("personal-bot@"));
  if (!candidates.length) return undefined;
  const scopedMatches: ClaudePluginEntry[] = [];
  for (const entry of candidates) {
    if (!entry.projectPath) {
      scopedMatches.push(entry);
      continue;
    }
    if (await resolvePathSafe(entry.projectPath) === canonicalWorkspace) scopedMatches.push(entry);
  }
  const priority = new Map<string, number>([["local", 0], ["project", 1], ["user", 2]]);
  scopedMatches.sort((a, b) => (priority.get(a.scope ?? "") ?? 9) - (priority.get(b.scope ?? "") ?? 9));
  return scopedMatches[0];
}

export const claudeUpgrader: HostUpgrader = {
  host: "claude",
  async upgrade(context: HostUpgradeContext): Promise<HostUpgradeResult> {
    const claude = context.env.PBOT_CLAUDE_COMMAND || await context.findExecutable("claude");
    if (!claude) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: "未找到 Claude Code CLI（claude），已跳过。",
      };
    }
    let entries: ClaudePluginEntry[];
    try {
      const raw = await context.run(claude, ["plugin", "list", "--json"], context.workspace);
      entries = parsePluginList(raw);
    } catch (error) {
      return {
        host: this.host,
        state: "failed",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: `查询 Claude 插件列表失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const entry = await selectMatchingEntry(entries, context.workspace);
    if (!entry) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: "未在 Claude 插件列表中找到 personal-bot（可能通过 --plugin-dir 本地加载），已跳过。",
      };
    }
    const installedVersion = entry.version ?? context.currentVersion;
    const scope = entry.scope ?? "user";
    if (installedVersion && valid(installedVersion) && gte(installedVersion, context.targetVersion)) {
      return {
        host: this.host,
        state: "up-to-date",
        previousVersion: installedVersion,
        version: installedVersion,
        scope,
        detail: "已是最新版本。",
      };
    }
    const atIndex = entry.id.indexOf("@");
    const marketplace = atIndex > 0 ? entry.id.slice(atIndex + 1) : undefined;
    if (marketplace) {
      try {
        await context.run(claude, ["plugin", "marketplace", "update", marketplace], context.workspace);
      } catch {
        // Continue to plugin update even if marketplace refresh is unsupported or cached.
      }
    }
    const updateArgs = ["plugin", "update", entry.id, "--yes"];
    if (entry.scope) updateArgs.push("--scope", entry.scope);
    await context.run(claude, updateArgs, context.workspace);
    return {
      host: this.host,
      state: "updated",
      ...(installedVersion ? { previousVersion: installedVersion } : {}),
      version: context.targetVersion,
      scope,
      detail: `已按原有作用域（${scope}）更新 ${entry.id}。`,
      nextStep: "重启 Claude Code 会话使新版本生效。",
    };
  },
};
