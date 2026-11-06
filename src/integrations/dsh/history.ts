import { realpath } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import type { HistoryExchange, HistoryLocation, HistorySession, HistorySource } from "../../model/history.js";
import { requireThat } from "../../common/validation.js";
import { finalDshAnswer } from "./messages.js";

type Question = Extract<SessionEvent, { type: "user/message" }>;
type Answer = Extract<SessionEvent, { type: "assistant/message" }>;
const text = (content: Question["data"]["content"]) => content.flatMap(block => block.type === "text" ? [block.text] :
  block.type === "image" ? ["[图片 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] :
    block.type === "file" ? ["[附件 " + (block.attachment.name ?? block.attachment.attachmentId) + "]"] : []).join("\n");

/** Archive questions and the final/partial answer; raw tool records stay in the native log. */
export function projectDshHistory(header: SessionHeader, events: readonly SessionEvent[], name = ""): HistorySession {
  const exchanges: HistoryExchange[] = [];
  let users: Question[] = [], answer: Answer | undefined;
  const finish = (completed = false) => {
    if (users.length) {
      const entries = [...users, ...(answer ? [answer] : [])];
      const body = answer ? answer.data.message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
      exchanges.push({ entryIds: entries.map(event => "dsh:" + event.seq), from: new Date(users[0]!.time).toISOString(),
        to: new Date(entries.at(-1)!.time).toISOString(),
        completed: completed && Boolean(answer && finalDshAnswer(answer).trim()),
        text: users.map(event => (event.data.source.kind === "user" ? "用户：\n" : "协调者要求：\n") + text(event.data.content)).join("\n\n") +
          (body ? "\n\n助手：\n" + body : "") });
    }
    users = []; answer = undefined;
  };
  for (const event of events) {
    if (event.type === "turn/start") finish();
    else if (event.type === "user/message" && ["user", "pbot-input"].includes(event.data.source.kind)) users.push(event);
    else if (event.type === "assistant/message" && users.length) answer = event;
    else if (event.type === "turn/end") finish(event.data.reason.kind === "completed");
  }
  finish();
  return { sessionId: header.id, name: name || exchanges[0]?.text.replace(/\s+/g, " ").slice(0, 80) || "",
    branches: exchanges.length ? [exchanges] : [] };
}

export class DshHistory implements HistorySource {
  readonly host = "dsh";
  constructor(private readonly ctx: Context, private readonly root: string, private readonly relatedSessions: () => string[] = () => []) {}
  async scan(location: HistoryLocation, signal?: AbortSignal) {
    requireThat(location.host === "dsh", "dsh 历史只读取 dsh 原生会话。");
    signal?.throwIfAborted();
    const records = await this.ctx.sessionQuery.listSessions(signal), selected = new Set<string>(), warnings: string[] = [];
    try { for (const id of this.relatedSessions()) selected.add(id); } catch (error) { warnings.push("专家引用：" + String(error)); }
    if (location.sessionId) selected.add(location.sessionId);
    for (const record of records) {
      signal?.throwIfAborted();
      if ((record.header.origin !== "subagent" || !record.header.parentSession) && record.header.cwd &&
        await realpath(record.header.cwd).catch(() => record.header.cwd) === this.root) selected.add(record.header.id);
    }
    // Native subagents may use a different cwd while still belonging to a workspace's parent.
    for (let changed = true; changed;) {
      changed = false;
      for (const record of records) if (record.header.origin === "subagent" && record.header.parentSession && selected.has(record.header.parentSession) && !selected.has(record.header.id)) {
        selected.add(record.header.id); changed = true;
      }
    }
    const sessions: HistorySession[] = [];
    for (const id of selected) {
      signal?.throwIfAborted();
      try {
        using observation = await this.ctx.sessionQuery.observeSession(SessionId(id), { ...(signal ? { signal } : {}), projectionMode: "none" });
        const title = await this.ctx.sessionQuery.readTitle(SessionId(id), signal);
        const session = projectDshHistory(observation.header, observation.events, title?.title);
        if (session.branches.length) sessions.push(session);
      } catch (error) { signal?.throwIfAborted(); warnings.push(id + ": " + String(error)); }
    }
    return { sessions, warnings };
  }
}
