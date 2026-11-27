import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HistoryExchange, HistoryHost, HistorySession, RawHistory } from "../../model/history.js";
import type { HistoryCapture } from "../../model/plugin-host.js";
import { HistoryFiles } from "../../storage/history-files.js";
import { indexHistory, retainHistorySummaries } from "./history-index.js";

function orderedExchanges(raw?: RawHistory): HistoryExchange[] {
  if (!raw) return [];
  const lookup = new Map(raw.exchanges.map(item => [item.id, item]));
  const path = raw.branches[0];
  const items = path?.length
    ? path.map(id => lookup.get(id)).filter((item): item is HistoryExchange & { id: string } => item !== undefined)
    : raw.exchanges;
  return items.map(({ entryIds, text, from, to, completed }) => ({ entryIds: [...entryIds], text, from, to, completed }));
}

function replaceAssistantSuffix(text: string, assistantText: string): string {
  const marker = "\n\n助手：\n";
  const index = text.lastIndexOf(marker);
  if (index >= 0) return text.slice(0, index) + marker + assistantText;
  return text ? `${text}${marker}${assistantText}` : `助手：\n${assistantText}`;
}

function buildSession(host: HistoryHost, capture: HistoryCapture, previous?: RawHistory): HistorySession | undefined {
  if (capture.kind === "session") {
    return capture.session.branches.length ? capture.session : undefined;
  }
  const timestamp = capture.timestamp ?? new Date().toISOString();
  const branch = orderedExchanges(previous);
  if (capture.kind === "input") {
    const text = capture.text.trim();
    if (!text) return undefined;
    const entryId = `${host}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    branch.push({
      entryIds: [entryId],
      text: "用户：\n" + text,
      from: timestamp,
      to: timestamp,
      completed: false,
    });
    return { sessionId: capture.sessionId, name: previous?.name ?? "", branches: [branch] };
  }
  const assistantText = capture.assistantText.trim();
  if (!assistantText) return undefined;
  const last = branch.at(-1);
  if (last && !last.completed) {
    last.text = replaceAssistantSuffix(last.text, assistantText);
    last.to = timestamp;
    last.completed = capture.completed;
  } else if (last && capture.isContinuation) {
    last.text = replaceAssistantSuffix(last.text, assistantText);
    last.to = timestamp;
    last.completed = capture.completed;
  } else {
    const entryId = `${host}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const userText = capture.userText?.trim();
    branch.push({
      entryIds: [entryId],
      text: userText ? `用户：\n${userText}\n\n助手：\n${assistantText}` : `助手：\n${assistantText}`,
      from: timestamp,
      to: timestamp,
      completed: capture.completed,
    });
  }
  return { sessionId: capture.sessionId, name: previous?.name ?? "", branches: [branch] };
}

/** Persist a plugin-host raw history observation atomically into .pbot/history/raw/. */
export function recordHistoryCapture(root: string, host: HistoryHost, capture: HistoryCapture): void {
  const sessionId = capture.kind === "session" ? capture.session.sessionId : capture.sessionId;
  if (!sessionId) return;
  const files = new HistoryFiles(join(root, ".pbot/history"), host);
  files.control(() => {
    const previous = files.list().find(({ raw }) => raw.sessionId === sessionId);
    if (!previous && files.rawWarnings.length) return;
    const session = buildSession(host, capture, previous?.raw);
    if (!session || !session.branches.length) return;
    const raw = indexHistory(session, previous?.raw, host);
    if (isDeepStrictEqual(raw, previous?.raw)) return;
    if (previous?.summaries?.length) {
      const retained = retainHistorySummaries(previous.raw, raw, previous.summaries);
      if (!isDeepStrictEqual(previous.summaries, retained)) {
        files.controlSummary(() => files.saveSummaries(previous.raw, retained));
      }
    }
    files.saveRaw(raw);
  });
}
