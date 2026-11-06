import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamLink, TeamMessage } from "../model/team.js";
import { markdownBlock } from "../common/markdown.js";
import { resourceRoot } from "../common/paths.js";

type MessagePage = Pick<TeamMessage, "seq" | "author" | "text" | "replyTo" | "runId" | "source"> & {
  offset: number; totalLength: number; nextOffset: number | null;
};

function messageMarkdown(message: MessagePage): string {
  return [
    "## 消息 " + message.seq, "",
    "- 作者：" + message.author.name + "（" + message.author.kind + "）",
    ...(message.author.agentId ? ["- `agentId`: `" + message.author.agentId + "`"] : []),
    ...(message.replyTo === undefined ? [] : ["- `replyTo`: `" + message.replyTo + "`"]),
    ...(message.runId ? ["- `runId`: `" + message.runId + "`"] : []),
    ...(message.source ? ["- `requestId`: `" + message.source.requestId + "`", "- `cycleId`: `" + message.source.cycleId + "`"] : []),
    "- `offset`: `" + message.offset + "`；`totalLength`: `" + message.totalLength + "`；`nextOffset`: `" + message.nextOffset + "`",
    "", markdownBlock(message.text),
    ...(message.nextOffset === null ? [] : ["", "正文未完。用 pbot_team_message read 续读：`seq: " + message.seq + ", offset: " + message.nextOffset + "`。"]),
  ].join("\n");
}

export function teamMessagesMarkdown(page: { teamId: string; messages: MessagePage[]; lastSeq: number; nextAfterSeq: number | null }): string {
  return ["# 团队公共消息", "", "- `teamId`: `" + page.teamId + "`", "- `lastSeq`: `" + page.lastSeq + "`",
    "- `nextAfterSeq`: `" + page.nextAfterSeq + "`", "",
    "nextOffset 非空时先续读该条正文，再读取后续消息。", "",
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
  return { content: ["# 团队公共上下文", "", "- `teamId`: `" + link.team.teamId + "`", "- `throughSeq`: `" + throughSeq + "`",
      "- `remainingFromSeq`: `" + (pending[messages.length]?.seq ?? null) + "`", "",
      "未包含或被截断的正文用 pbot_team_message read 读取。remainingFromSeq 非空时，用 afterSeq: remainingFromSeq - 1 读取未包含的消息。", "",
      messages.map(messageMarkdown).join("\n\n")].join("\n"),
    seqs };
}
