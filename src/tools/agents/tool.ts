import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../services/agents/agent-service.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import type { CallAccess } from "../access.js";
import { requireThat, schema } from "../../common/validation.js";
import { executeAgent } from "./actions.js";
import { agentDescription, agentActionSchema, agentParametersSchema, agentResultSchema } from "./contract.js";

export function agentTool(service: AgentService, access: CallAccess) {
  const validators = new Map(agentActionSchema.anyOf.map(action => [action.properties.action.const, schema(action)]));
  return defineTool({ name: "pbot_agent", label: "子会话",
    description: agentDescription,
    parameters: agentParametersSchema, outputSchema: agentResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      const valid = validators.get(args.action);
      requireThat(valid, "未知的子会话 action：" + args.action);
      requireThat(valid(args), "子会话 " + args.action + " 参数无效：" + JSON.stringify(valid.errors));
      return executeAgent(service, args, agentOwner(ctx), {
        ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
        ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
      });
    },
  });
}
