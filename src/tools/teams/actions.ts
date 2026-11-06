import type { Static } from "typebox";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { TeamActor } from "../../model/team.js";
import type { AgentOwner } from "../../model/agent.js";
import { teamMessagesMarkdown } from "../../integrations/team-context.js";
import { markdownResult, result } from "../result.js";
import type { teamParametersSchema, teamMessageParametersSchema } from "./contract.js";

export function executeTeam(service: TeamService, agents: AgentService, input: Static<typeof teamParametersSchema>, owner: AgentOwner) {
  const views = agents.list(owner);
  service.recover(owner);
  let id = input.teamId!;
  switch (input.action) {
    case "create": id = service.create(owner, { name: input.name!, brief: input.brief!, members: input.members! }, views).teamId; break;
    case "list": return markdownResult({ teams: service.list(owner, views) }, "团队列表");
    case "read": {
      const page = service.read(id, { kind: "coordinator", owner }, input);
      return result(page, false, teamMessagesMarkdown(page));
    }
    case "run": service.run(id, owner, { instruction: input.instruction!, mode: input.mode!,
      ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
      ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }) }, views); break;
    case "pause": service.pause(id, owner); break;
    case "close": service.close(id, owner, views); break;
  }
  return markdownResult(service.status(id, owner, views), "团队状态");
}

export function executeTeamMessage(service: TeamService, input: Static<typeof teamMessageParametersSchema>, actor: TeamActor, requestId: string) {
  if (input.action === "read") {
    const page = service.read(input.teamId, actor, input);
    return result(page, false, teamMessagesMarkdown(page));
  }
  const message = service.post(input.teamId, actor, requestId, input.text!, input.replyTo);
  return markdownResult({ teamId: input.teamId, seq: message.seq, status: "stored" }, "团队消息已保存");
}
