import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { dshParameters, dshOutputSchema } from "../../integrations/dsh/schema.js";
import type { Static } from "typebox";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOwner } from "../../model/agent.js";
import type { TeamActor } from "../../model/team.js";
import { object } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import { markdownFields } from "../../common/markdown.js";
import { teamMessagesMarkdown } from "../../integrations/team-context.js";
import { executeTeam, executeTeamMessage } from "./actions.js";
import { teamDescription, teamMessageDescription, teamParametersSchema, teamActionSchema, teamResultSchema,
  teamMessageParametersSchema, teamMessageActionSchema, teamMessageResultSchema } from "./contract.js";

export function registerDshTeamTool(ctx: Context, agent: Agent, service: TeamService, agents: AgentService, owner: AgentOwner, check: () => void) {
  const validators = new Map(teamActionSchema.anyOf.map(row => [row.properties.action.const, schema(row)]));
  const validOutput = schema(teamResultSchema);
  ctx.tools.register({ name: "pbot_team", description: teamDescription, parameters: dshParameters(teamParametersSchema),
    output: {
      schema: dshOutputSchema(teamResultSchema),
      render: (args, value) => [{ type: "text", text: object(args) && args.action === "read"
        ? teamMessagesMarkdown(value as unknown as ReturnType<TeamService["read"]>) : "# 团队\n\n" + markdownFields(value) }],
    },
    async execute(args, exec) {
      check(); exec.signal.throwIfAborted();
      requireThat(exec.agent === agent && object(args) && typeof args.action === "string", "团队工具会话或参数无效。");
      const valid = validators.get(args.action);
      requireThat(valid && valid(args), "团队参数无效。");
      const value = executeTeam(service, agents, args as Static<typeof teamParametersSchema>, owner).structuredContent;
      requireThat(validOutput(value), "团队输出不符合契约。"); return value;
    },
  });
}

export function registerDshTeamMessageTool(ctx: Context, agent: Agent, service: TeamService, actor: () => TeamActor, check: () => void) {
  const validators = new Map<string, ReturnType<typeof schema>>(teamMessageActionSchema.anyOf.map(row => [row.properties.action.const, schema(row)]));
  const validOutput = schema(teamMessageResultSchema);
  ctx.tools.register({ name: "pbot_team_message", description: teamMessageDescription, parameters: dshParameters(teamMessageParametersSchema),
    output: {
      schema: dshOutputSchema(teamMessageResultSchema),
      render: (args, value) => [{ type: "text", text: object(args) && args.action === "read"
        ? teamMessagesMarkdown(value as unknown as ReturnType<TeamService["read"]>) : "# 团队消息\n\n" + markdownFields(value) }],
    },
    async execute(args, exec) {
      check(); exec.signal.throwIfAborted();
      requireThat(exec.agent === agent && object(args) && typeof args.action === "string", "团队消息会话或参数无效。");
      const valid = validators.get(args.action);
      requireThat(valid && valid(args), "团队消息参数无效。");
      const value = executeTeamMessage(service, args as Static<typeof teamMessageParametersSchema>, actor(), exec.callId).structuredContent;
      requireThat(validOutput(value), "团队消息输出不符合契约。"); return value;
    },
  });
}
