import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { TeamActor } from "../../model/team.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import { requireThat, schema } from "../../common/validation.js";
import type { CallAccess } from "../access.js";
import { executeTeam, executeTeamMessage } from "./actions.js";
import { teamDescription, teamMessageDescription, teamParametersSchema, teamActionSchema, teamResultSchema, teamMessageParametersSchema, teamMessageActionSchema, teamMessageResultSchema } from "./contract.js";

export function teamTool(service: TeamService, agents: AgentService, access: Pick<CallAccess, "check">) {
  const validators = new Map(teamActionSchema.anyOf.map(action => [action.properties.action.const, schema(action)]));
  return defineTool({ name: "pbot_team", label: "团队",
    description: teamDescription,
    parameters: teamParametersSchema, outputSchema: teamResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      const valid = validators.get(args.action);
      requireThat(valid, "未知的团队 action：" + args.action);
      requireThat(valid(args), "团队 " + args.action + " 参数无效：" + JSON.stringify(valid.errors));
      return executeTeam(service, agents, args, agentOwner(ctx));
    },
  });
}
export function teamMessageTool(service: TeamService, access: Pick<CallAccess, "check">, actor: (ctx: ExtensionContext) => TeamActor) {
  const validators = new Map(teamMessageActionSchema.anyOf.map(action => [action.properties.action.const, schema(action)]));
  return defineTool({ name: "pbot_team_message", label: "团队消息",
    description: teamMessageDescription,
    parameters: teamMessageParametersSchema, outputSchema: teamMessageResultSchema,
    async execute(id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      const valid = validators.get(args.action);
      requireThat(valid, "未知的团队消息 action：" + args.action);
      requireThat(valid(args), "团队消息 " + args.action + " 参数无效：" + JSON.stringify(valid.errors));
      return executeTeamMessage(service, args, actor(ctx), id);
    },
  });
}
