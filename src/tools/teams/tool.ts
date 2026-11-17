import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { TeamActor } from "../../model/team.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import type { CallAccess } from "../access.js";
import { executeTeam, executeTeamMessage } from "./actions.js";
import { teamDescription, teamMessageDescription, teamInput, teamMessageInput, teamParametersSchema, teamResultSchema, teamMessageParametersSchema, teamMessageResultSchema } from "./contract.js";

export function teamTool(service: TeamService, agents: AgentService, access: Pick<CallAccess, "check">) {
  return defineTool({ name: "pbot_team", label: "团队",
    description: teamDescription,
    parameters: teamParametersSchema, outputSchema: teamResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      return executeTeam(service, agents, teamInput(args), agentOwner(ctx));
    },
  });
}
export function teamMessageTool(service: TeamService, access: Pick<CallAccess, "check">, actor: (ctx: ExtensionContext) => TeamActor) {
  return defineTool({ name: "pbot_team_message", label: "团队消息",
    description: teamMessageDescription,
    parameters: teamMessageParametersSchema, outputSchema: teamMessageResultSchema,
    async execute(id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      return executeTeamMessage(service, teamMessageInput(args), actor(ctx), id);
    },
  });
}
