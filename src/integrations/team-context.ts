import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamLink, TeamMessage } from "../model/team.js";
import { markdownBlock } from "../common/markdown.js";
import { resourceRoot } from "../common/paths.js";

type MessagePage = Pick<TeamMessage, "seq" | "author" | "text" | "replyTo" | "runId" | "source"> & {
  offset: number; totalLength: number; nextOffset: number | null;
};

function messageMarkdown(message: MessagePage): string {
  const partial = message.offset > 0 || message.nextOffset !== null;
  return [
    "## 消息 " + message.seq, "",
    "- 作者：" + message.author.name + "（" + message.author.kind + "）",
    ...(message.author.agentId ? ["- `agentId`: `" + message.author.agentId + "`"] : []),
    ...(message.replyTo === undefined ? [] : ["- `replyTo`: `" + message.replyTo + "`"]),
    ...(message.runId ? ["- `runId`: `" + message.runId + "`"] : []),
    ...(message.source ? ["- `requestId`: `" + message.source.requestId + "`", "- `cycleId`: `" + message.source.cycleId + "`"] : []),
    ...(partial ? ["- `offset`: `" + message.offset + "`；`totalLength`: `" + message.totalLength + "`；`nextOffset`: `" + message.nextOffset + "`"] : []),
    "", markdownBlock(message.text),
    ...(message.nextOffset === null ? [] : ["", "正文未完，用 `pbot_team_message read` 续读：`seq: " + message.seq + ", offset: " + message.nextOffset + "`。"]),
  ].join("\n");
}

export function teamMessagesMarkdown(page: { teamId: string; messages: MessagePage[]; lastSeq: number; nextAfterSeq: number | null }): string {
  const hasPartial = page.messages.some(message => message.nextOffset !== null);
  return ["# 团队公共消息", "", "- `teamId`: `" + page.teamId + "`", "- `lastSeq`: `" + page.lastSeq + "`",
    "- `nextAfterSeq`: `" + page.nextAfterSeq + "`",
    ...(hasPartial ? ["", "有消息的 `nextOffset` 非空，先按 `seq`/`offset` 续读完正文，再读取后续消息。"] : []), "",
    page.messages.map(messageMarkdown).join("\n\n")].join("\n");
}

export function teamBrief(link: TeamLink): string {
  return ["# 团队协作", "", "- 团队：" + link.team.name, "- `teamId`: `" + link.team.teamId + "`",
    "- 当前成员 `agentId`: `" + link.request.agentId + "`", "- `runId`: `" + link.run.runId + "`",
    "- 轮次：" + link.request.round + " / " + link.run.rounds, "", "## 共同目标", "", link.team.brief,
    "", "## 成员职责", "", ...link.team.members.flatMap(member => ["### " + member.agentId, "", member.role, ""]),
    readFileSync(join(resourceRoot, "prompts/team-member.md"), "utf8").trim()].join("\n");
}

export function createTeamContext(link: TeamLink, seen: ReadonlySet<number>, throughSeq = link.team.messages.length) {
  const pending = link.team.messages.filter(m => m.seq <= throughSeq && !seen.has(m.seq));
  if (!pending.length) return;
  // Count rendered Markdown, including fences and read positions; reserve room for the document header.
  let budget = 15000;
  const messages: MessagePage[] = [];
  for (const m of pending) {
    const part = (length: number): MessagePage => ({ ...m, text: m.text.slice(0, length),
      offset: 0, totalLength: m.text.length, nextOffset: length < m.text.length ? length : null });
    let low = 0, high = Math.min(m.text.length, budget);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (messageMarkdown(part(mid)).length + 2 <= budget) low = mid; else high = mid - 1;
    }
    const value = part(low), size = messageMarkdown(value).length + 2;
    if (size > budget || (!low && m.text.length)) break;
    messages.push(value); budget -= size;
  }
  const seqs = messages.map(m => m.seq);
  const nextAfterSeq = pending[messages.length] ? pending[messages.length]!.seq - 1 : null;
  const hasMore = nextAfterSeq !== null || messages.some(m => m.nextOffset !== null);
  return { content: ["# 团队公共上下文", "", "- `teamId`: `" + link.team.teamId + "`", "- `throughSeq`: `" + throughSeq + "`",
      "- `nextAfterSeq`: `" + nextAfterSeq + "`",
      ...(hasMore ? ["", "正文未完用 `pbot_team_message read` 按 `seq`/`offset` 续读；`nextAfterSeq` 非空时用 `afterSeq` 读取后续消息。"] : []), "",
      messages.map(messageMarkdown).join("\n\n")].join("\n"),
    seqs };
}
