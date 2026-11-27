import { lastAssistantStreamChunk, type UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** Producer metadata travels with native messages and never grants task authorization. */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "pbot-input": { kind: "pbot-input"; form: "relay"; requestId: string; generation: string; parentSessionId: string };
    "pbot-team-context": { kind: "pbot-team-context"; form: "relay"; teamId: string; seqs: number[] };
    "pbot-results": { kind: "pbot-results"; form: "notice"; summary: string; keys: string[] };
  }
}

export function finalDshAnswer(event: Extract<SessionEvent, { type: "assistant/message" }>) {
  const { message, interrupted, stream } = event.data;
  if (interrupted || message.content.some(block => block.type === "tool-call") || lastAssistantStreamChunk(stream, "finish")?.reason.kind !== "stop") return "";
  return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

export function requestSource(message: UserMessage, generation: string) {
  const source = message.source;
  return source.kind === "pbot-input" && source.generation === generation ? source : undefined;
}
