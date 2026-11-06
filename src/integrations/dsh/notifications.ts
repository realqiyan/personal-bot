import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tool-executor-ptc";
import { object } from "../../common/json.js";
import "./messages.js";

function keys(value: unknown, field: string) {
  if (!object(value)) return [];
  const items = value[field];
  return Array.isArray(items) && items.every(item => typeof item === "string") ? items as string[] : [];
}

/** Only committed native context or successful model tool results claim notices.
 * PTC inner reads require their enclosing transport to have committed success. */
export function deliveredDshNotices(events: readonly SessionEvent[]) {
  const delivered = new Set<string>();
  const reads = new Set<string>(), nested = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === "turn/start" || event.type === "step/start" || event.type === "turn/end") { reads.clear(); nested.clear(); }
    if (event.type === "user/message" && event.data.source.kind === "pbot-results") {
      for (const key of keys(event.data.source, "keys")) delivered.add(key);
    }
    if (event.type === "tool/call" && event.data.name === "pbot_agent") {
      try { const args: unknown = JSON.parse(event.data.arguments); if (object(args) && args.action === "read") reads.add(event.data.callId); } catch { /* An invalid call cannot claim a report. */ }
    }
    if (event.type === "tool/ptc-dispatch" && event.data.name === "pbot_agent" && !event.data.isError &&
      object(event.data.arguments) && event.data.arguments.action === "read") {
      const values = nested.get(event.data.rootCallId) ?? [];
      values.push(...keys(event.data.meta, "pbotAgentReadKeys")); nested.set(event.data.rootCallId, values);
    }
    if (event.type === "tool/result") {
      const message = event.data.message;
      if (!message.isError) {
        if (reads.has(message.toolCallId)) for (const key of keys(event.data.meta, "pbotAgentReadKeys")) delivered.add(key);
        for (const key of nested.get(message.toolCallId) ?? []) delivered.add(key);
      }
      reads.delete(message.toolCallId); nested.delete(message.toolCallId);
    }
  }
  return delivered;
}

/** Pending inbox entries prevent duplicate submission, but are not delivery receipts. */
export function pendingDshNotices(messages: readonly UserMessage[]) {
  return messages.flatMap(message => message.source.kind === "pbot-results" ? keys(message.source, "keys") : []);
}
