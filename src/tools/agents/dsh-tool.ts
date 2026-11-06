import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { dshParameters, dshOutputSchema } from "../../integrations/dsh/schema.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOwner } from "../../model/agent.js";
import { object, json } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import { markdownFields } from "../../common/markdown.js";
import { executeAgent, type AgentInput } from "./actions.js";
import { agentDescription, agentResultSchema } from "./contract.js";
import { dshAgentActionSchema, dshAgentParametersSchema } from "./dsh-contract.js";

export function registerDshAgentTool(ctx: Context, agent: Agent, service: AgentService, owner: AgentOwner, check: () => void) {
  const validators = new Map(dshAgentActionSchema.anyOf.map(row => [row.properties.action.const, schema(row)]));
  const validOutput = schema(agentResultSchema);
  ctx.tools.register({ name: "pbot_agent", description: agentDescription,
    parameters: dshParameters(dshAgentParametersSchema),
    output: {
      schema: dshOutputSchema(agentResultSchema),
      render: (_args, value) => [{ type: "text", text: "# 专家\n\n" + markdownFields(value) }],
      presentationMeta: (args, value) => {
        if (!object(args) || args.action !== "read" || !object(value) || !object(value.cycle) || value.cycle.state === "running") return {};
        return json({ pbotAgentReadKeys: [String(value.agentId) + ":" + String(value.cycle.cycleId)] });
      },
    },
    async execute(args, exec) {
      check(); exec.signal.throwIfAborted();
      requireThat(exec.agent === agent && object(args) && typeof args.action === "string", "专家工具会话或参数无效。");
      const valid = validators.get(args.action);
      requireThat(valid && valid(args), "dsh 专家参数无效或包含不支持的宿主选项。");
      const selection = agent.model.current();
      const output = await executeAgent(service, args as AgentInput, owner, selection ? {
        provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort && (!args.provider || args.provider === selection.provider) && (!args.model || args.model === selection.model)
          ? { thinking: selection.reasoningEffort } : {}),
      } : {});
      requireThat(validOutput(output.structuredContent), "专家输出不符合契约。");
      return output.structuredContent;
    },
  });
}
