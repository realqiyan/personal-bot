import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HistoryExchange, HistoryHost, HistorySession, RawHistory } from "../../model/history.js";
import type { HistoryCapture } from "../../model/plugin-host.js";
import { workspaceHistoryFiles } from "./workspace-history.js";
import { indexHistory, orderedRawExchanges } from "./history-index.js";

function orderedExchanges(raw?: RawHistory): HistoryExchange[] {
  if (!raw) return [];
  return orderedRawExchanges(raw).map(({ entryIds, text, from, to, completed }) => ({
    entryIds: [...entryIds],
    text,
    from,
    to,
    completed,
  }));
}

function replaceAssistantSuffix(text: string, assistantText: string): string {
  const marker = "\n\n助手：\n";
  const section = `助手：\n${assistantText}`;
  if (text === section || text.endsWith("\n\n" + section)) return text;
  if (!text || text.startsWith("助手：\n")) return section;
  const index = text.lastIndexOf(marker);
  if (index >= 0) return text.slice(0, index) + marker + assistantText;
  return text + marker + assistantText;
}

function buildSession(host: HistoryHost, capture: HistoryCapture, previous?: RawHistory): HistorySession | undefined {
  if (capture.kind === "session") {
    return capture.session.branches.length ? capture.session : undefined;
  }
  const timestamp = capture.timestamp ?? new Date().toISOString();
  const branch = orderedExchanges(previous);
  // entryIds already identify native observations on disk. A turn keeps its ID
  // across steering, attachment-only inputs and Stop hooks arriving out of order.
  const turnEntry = capture.turnId ? `${host}:turn:${capture.turnId}` : undefined;
  const turn = turnEntry ? branch.find(item => item.entryIds.includes(turnEntry)) : undefined;
  const entryId = () => turnEntry ?? `${host}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  if (capture.kind === "input") {
    const text = capture.text.trim();
    if (!text && !turnEntry) return undefined;
    const input = "用户：\n" + (text || "（无文本输入）");
    if (turn) {
      turn.text += "\n\n" + input;
      turn.to = timestamp;
      turn.completed = false;
    } else {
      branch.push({ entryIds: [entryId()], text: input, from: timestamp, to: timestamp, completed: false });
    }
    return { sessionId: capture.sessionId, name: previous?.name ?? "", branches: [branch] };
  }
  const assistantText = capture.assistantText.trim();
  if (!assistantText) return undefined;
  const target = turnEntry ? turn : branch.at(-1);
  if (target && (turnEntry || !target.completed || capture.isContinuation)) {
    const updated = turnEntry && !target.completed
      ? target.text + "\n\n助手：\n" + assistantText
      : replaceAssistantSuffix(target.text, assistantText);
    if (target.text === updated && target.completed === capture.completed) return undefined;
    target.text = updated;
    target.to = timestamp;
    target.completed = capture.completed;
  } else {
    const userText = capture.userText?.trim();
    branch.push({
      entryIds: [entryId()],
      text: userText ? `用户：\n${userText}\n\n助手：\n${assistantText}` : `助手：\n${assistantText}`,
      from: timestamp,
      to: timestamp,
      completed: capture.completed,
    });
  }
  return { sessionId: capture.sessionId, name: previous?.name ?? "", branches: [branch] };
}

/** Persist a host raw history observation atomically into .pbot/history/raw/. */
export function recordHistoryCapture(root: string, host: HistoryHost, capture: HistoryCapture): void {
  const sessionId = capture.kind === "session" ? capture.session.sessionId : capture.sessionId;
  if (!sessionId) return;
  const files = workspaceHistoryFiles(root, host);
  files.control(() => {
    const previous = files.listRaw(host).find(raw => raw.sessionId === sessionId);
    if (!previous && files.rawWarnings.length) return;
    const session = buildSession(host, capture, previous);
    if (!session || !session.branches.length) return;
    const raw = indexHistory(session, previous, host);
    if (isDeepStrictEqual(raw, previous)) return;
    files.saveRaw(raw);
  });
}
