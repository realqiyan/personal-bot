import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamLink } from "../../model/team.js";
import { createTeamContext } from "../team-context.js";

/** Branch-local context, not a durable read receipt. */
export function teamContext(link: TeamLink, ctx: ExtensionContext, throughSeq = link.team.messages.length): CustomMessageEntryDraft | undefined {
  const seen = new Set<number>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom_message" || entry.customType !== "pbot.team-context") continue;
    const data = entry.details as { teamId?: string; seqs?: number[] } | undefined;
    if (data?.teamId === link.team.teamId) for (const seq of data.seqs ?? []) seen.add(seq);
  }
  const value = createTeamContext(link, seen, throughSeq);
  if (!value) return;
  return { type: "custom_message", customType: "pbot.team-context", display: true,
    content: value.content, details: { teamId: link.team.teamId, seqs: value.seqs } };
}
export function deliveredTeams(ctx: ExtensionContext) {
  const keys = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom_message" || entry.customType !== "pbot.team-results") continue;
    const details = entry.details as { keys?: unknown } | undefined;
    if (Array.isArray(details?.keys)) for (const key of details.keys) if (typeof key === "string") keys.add(key);
  }
  return keys;
}
