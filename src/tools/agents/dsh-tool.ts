import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { dshParameters, dshOutputSchema } from "../../integrations/dsh/schema.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOwner } from "../../model/agent.js";
import { object, json } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { markdownFields } from "../../common/markdown.js";
import { executeAgent } from "./actions.js";
import { agentDescription, agentInput, agentParametersSchema, agentResultSchema } from "./contract.js";

export function registerDshAgentTool(ctx: Context, agent: Agent, service: AgentService, owner: AgentOwner, check: () => void) {
  const validOutput = schema(agentResultSchema);
  ctx.tools.register({ name: "pbot_agent", description: agentDescription,
    parameters: dshParameters(agentParametersSchema),
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
      requireThat(exec.agent === agent, "专家工具不属于当前会话。");
      const input = agentInput(args), selection = agent.model.current();
      const output = await executeAgent(service, input, owner, selection ? {
        provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort ? { thinking: selection.reasoningEffort } : {}),
      } : {});
      requireThat(validOutput(output.structuredContent), "专家输出不符合契约。");
      return output.structuredContent;
    },
  });
}
