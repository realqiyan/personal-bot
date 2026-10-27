import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOwner } from "../../model/agent.js";
export function agentOwner(ctx: ExtensionContext): AgentOwner {
  return { sessionId: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch().map(e => e.id) };
}
export function deliveredCycles(ctx: ExtensionContext): Set<string> {
  const keys = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    const data = entry.type === "custom_message" && entry.customType === "pbot.agent-results" ? entry.details
      : entry.type === "custom" && entry.customType === "pbot.agent-read" ? entry.data : undefined;
    if (entry.type === "custom" && entry.customType === "pbot.agent-read") {
      const receipt = entry.data as { toolCallId?: string };
      if (!ctx.sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === receipt.toolCallId)) continue;
    }
    if (data && typeof data === "object" && "keys" in data && Array.isArray(data.keys)) for (const key of data.keys) if (typeof key === "string") keys.add(key);
  }
  return keys;
}
