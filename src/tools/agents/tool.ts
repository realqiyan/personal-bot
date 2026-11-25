import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../services/agents/agent-service.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import type { CallAccess } from "../access.js";
import { executeAgent } from "./actions.js";
import { agentDescription, agentInput, agentParametersSchema, agentResultSchema } from "./contract.js";

export function agentTool(service: AgentService, access: CallAccess) {
  return defineTool({ name: "pbot_agent", label: "专家",
    description: agentDescription,
    parameters: agentParametersSchema, outputSchema: agentResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      return executeAgent(service, agentInput(args), agentOwner(ctx), {
        ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
        ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
      });
    },
  });
}
