import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { dshParameters, dshOutputSchema } from "../../integrations/dsh/schema.js";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOwner } from "../../model/agent.js";
import type { TeamActor } from "../../model/team.js";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { markdownFields } from "../../common/markdown.js";
import { teamMessagesMarkdown } from "../../integrations/team-context.js";
import { executeTeam, executeTeamMessage } from "./actions.js";
import { teamDescription, teamMessageDescription, teamInput, teamMessageInput, teamParametersSchema, teamResultSchema,
  teamMessageParametersSchema, teamMessageResultSchema } from "./contract.js";

export function registerDshTeamTool(ctx: Context, agent: Agent, service: TeamService, agents: AgentService, owner: AgentOwner, check: () => void) {
  const validOutput = schema(teamResultSchema);
  ctx.tools.register({ name: "pbot_team", description: teamDescription, parameters: dshParameters(teamParametersSchema),
    output: { schema: dshOutputSchema(teamResultSchema), render: (_args, value) => [{ type: "text", text: "# 团队\n\n" + markdownFields(value) }] },
    async execute(args, exec) {
      check(); exec.signal.throwIfAborted();
      requireThat(exec.agent === agent, "团队工具不属于当前会话。");
      const value = executeTeam(service, agents, teamInput(args), owner).structuredContent;
      requireThat(validOutput(value), "团队输出不符合契约。"); return value;
    },
  });
}

export function registerDshTeamMessageTool(ctx: Context, agent: Agent, service: TeamService, actor: () => TeamActor, check: () => void) {
  const validOutput = schema(teamMessageResultSchema);
  ctx.tools.register({ name: "pbot_team_message", description: teamMessageDescription, parameters: dshParameters(teamMessageParametersSchema),
    output: {
      schema: dshOutputSchema(teamMessageResultSchema),
      render: (args, value) => [{ type: "text", text: object(args) && args.action === "read"
        ? teamMessagesMarkdown(value as unknown as ReturnType<TeamService["read"]>) : "# 团队消息\n\n" + markdownFields(value) }],
    },
    async execute(args, exec) {
      check(); exec.signal.throwIfAborted();
      requireThat(exec.agent === agent, "团队消息工具不属于当前会话。");
      const value = executeTeamMessage(service, teamMessageInput(args), actor(), exec.callId).structuredContent;
      requireThat(validOutput(value), "团队消息输出不符合契约。"); return value;
    },
  });
}
