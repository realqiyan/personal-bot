import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionEntries, SessionManager, type ExtensionContext, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { HistoryExchange, HistoryLocation, HistorySession, HistorySource, HistorySummarizer } from "../../model/history.js";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";
import { reduceHistorySummary } from "../history-summary.js";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block.type === "text" ? [String(block.text)] : block.type === "image" ? ["[图片]"] : []).join("\n");
}
function exchanges(branch: SessionEntry[]): HistoryExchange[] {
  const result: HistoryExchange[] = [];
  let users: SessionMessageEntry[] = [], partial: SessionMessageEntry | undefined;
  const finish = (answer?: SessionMessageEntry, completed = false) => {
    if (!users.length) return;
    const entries = [...users, ...(answer ? [answer] : [])];
    result.push({ entryIds: entries.map(entry => entry.id), from: users[0]!.timestamp, to: entries.at(-1)!.timestamp, completed,
      text: users.map(entry => "用户：\n" + text("content" in entry.message ? entry.message.content : "")).join("\n\n") +
        (answer && "content" in answer.message ? "\n\n助手：\n" + text(answer.message.content) : "") });
    users = []; partial = undefined;
  };
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      if (partial?.message.role === "assistant" && ["aborted", "error"].includes(partial.message.stopReason)) finish(partial);
      users.push(entry);
    } else if (message.role === "assistant" && users.length) {
      partial = entry;
      if (message.stopReason === "stop" && !message.content.some(block => block.type === "toolCall")) finish(entry, true);
    }
  }
  finish(partial);
  return result;
}

/** Parse in memory; never open a writable SessionManager or migrate native JSONL. */
export function projectHistory(content: string): HistorySession {
  const parsed = parseSessionEntries(content), header = parsed[0];
  requireThat(header?.type === "session", "缺少 Pi 会话头。");
  const manager = SessionManager.inMemory(header.cwd, undefined, parsed), entries = manager.getEntries();
  const parents = new Set(entries.map(entry => entry.parentId));
  const tips = entries.filter(entry => !parents.has(entry.id));
  return { sessionId: header.id, name: manager.getSessionName() ?? "", branches: tips.map(tip => exchanges(manager.getBranch(tip.id))).filter(branch => branch.length) };
}

export const historyLocation = (ctx: ExtensionContext): HistoryLocation => {
  const file = ctx.sessionManager.getSessionFile();
  return { directory: ctx.sessionManager.getSessionDir(), ...(file ? { file } : {}) };
};
export class PiHistory implements HistorySource {
  readonly host = "pi";
  constructor(private readonly root: string, private readonly relatedFiles: () => string[] = () => []) {}
  async scan(location: HistoryLocation, signal?: AbortSignal) {
    requireThat(location.host !== "dsh", "Pi 历史只读取 Pi 原生会话。");
    const lists = await Promise.all([SessionManager.list(this.root, undefined, undefined, signal),
      SessionManager.list(this.root, location.directory, undefined, signal)]);
    const files = new Set([...lists.flat().map(session => session.path), ...this.relatedFiles(), ...(location.file ? [location.file] : [])]);
    const sessions: HistorySession[] = [], warnings: string[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      try {
        const session = projectHistory(await readFile(file, { encoding: "utf8", signal }));
        if (session.branches.length) {
          session.name ||= session.branches[0]![0]!.text.replace(/\s+/g, " ").slice(0, 80);
          sessions.push(session);
        }
      } catch (error) {
        signal?.throwIfAborted();
        // Pi reserves a filename before the first message; copied archives may also outlive their native files.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${file}: ${String(error)}`);
      }
    }
    return { sessions, warnings };
  }
}

export async function historySummarizer(ctx: ExtensionContext): Promise<HistorySummarizer> {
  const model = ctx.model;
  requireThat(model, "请先选择 Pi 模型。");
  const systemPrompt = await readFile(join(resourceRoot, "prompts/history-summary.md"), "utf8");
  const budget = Math.max(2000, Math.min(24000, Math.floor(model.contextWindow / 2)));
  const ask = async (content: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const response = await ctx.modelRegistry.streamSimple(model, { systemPrompt,
      messages: [{ role: "user", content, timestamp: Date.now() }] }, { signal, reasoning: "low", maxTokens: 2048, transport: "sse" }).result();
    signal.throwIfAborted();
    requireThat(response.stopReason === "stop", response.errorMessage ?? "历史摘要未完成：" + response.stopReason);
    const answer = response.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    requireThat(answer, "历史摘要为空。");
    return answer;
  };
  return reduceHistorySummary(budget, ask);
}
