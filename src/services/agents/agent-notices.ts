import type { AgentCompletion } from "../../model/agent.js";
import type { TeamLink } from "../../model/team.js";
import type { TeamService } from "./team-service.js";
import { json } from "../../common/json.js";
import { markdownFields } from "../../common/markdown.js";

export function teamNotice(values: ReturnType<TeamService["notifications"]>, known: ReadonlySet<string>) {
  const notes = values.filter(value => !known.has(value.key)).slice(0, 8);
  if (!notes.length) return;
  return { kind: "teams" as const, keys: notes.map(value => value.key), content: ["# 团队批次状态", "",
    "团队批次状态已变化，用 pbot_team status/read 查看状态和结果。暂停时可能仍有在途工作，重跑前先查看原请求结果。", "",
    notes.map(value => ["## " + value.name, "", "- `teamId`: `" + value.teamId + "`", "- `runId`: `" + value.runId + "`",
      "- 状态：" + value.state, "- 在途工作：" + value.activeCount, ...(value.reason ? ["", "### 原因", "", value.reason] : [])].join("\n")).join("\n\n")].join("\n") };
}

export function agentNotice(values: AgentCompletion[], links: ReadonlyMap<string, TeamLink>, known: ReadonlySet<string>) {
  const batch = values.filter(value => !value.cycle.requestIds.some(id => links.has(id)) &&
    !(value.cycle.cycleId === value.cycle.generation && [...links.values()].some(link => link.request.agentId === value.agentId && link.request.generation === value.cycle.generation)) &&
    !known.has(value.agentId + ":" + value.cycle.cycleId)).slice(0, 8);
  if (!batch.length) return;
  return { kind: "agents" as const, keys: batch.map(value => value.agentId + ":" + value.cycle.cycleId),
    content: "# 子会话工作结果\n\n子会话工作已结束。完整报告用 pbot_agent read 读取，指定对应 agentId 和 cycle.cycleId；nextOffset 非空时沿用该 cycleId 续读。\n\n" +
      (batch.some(value => value.cycle.source !== "parent") ? "部分结果包含人工子会话输入，来源见 cycle.source。\n\n" : "") +
      batch.map(value => "## " + value.name + "\n\n" + markdownFields(json({ agentId: value.agentId,
        cycle: { cycleId: value.cycle.cycleId, state: value.cycle.state, source: value.cycle.source, requestIds: value.cycle.requestIds,
          ...(value.cycle.error === undefined ? {} : { error: value.cycle.error }) },
        report: value.report.slice(0, 2000), truncated: value.report.length > 2000 }), 3)).join("\n\n") };
}
