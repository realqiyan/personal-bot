import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HistoryService } from "../../services/history/history-service.js";
import { dshParameters, dshOutputSchema } from "../../integrations/dsh/schema.js";
import { requireThat, schema } from "../../common/validation.js";
import { json } from "../../common/json.js";
import { markdownFields } from "../../common/markdown.js";
import { historyDescription, historyInput, historyParameters, historyResultSchema } from "./contract.js";
import { executeHistory } from "./actions.js";

export function registerDshHistoryTool(ctx: Context, agent: Agent, service: HistoryService, lifetime: AbortSignal, check: () => void) {
  const valid = schema(historyResultSchema);
  ctx.tools.register({ name: "pbot_history", description: historyDescription, parameters: dshParameters(historyParameters),
    output: { schema: dshOutputSchema(historyResultSchema), render: (_args, value) => [{ type: "text", text: "# 历史\n\n" + markdownFields(value) }] },
    async execute(value, exec) {
      check(); requireThat(exec.agent === agent, "历史工具不属于当前会话。");
      const signal = AbortSignal.any([exec.signal, lifetime]);
      const result = await executeHistory(service, historyInput(value), { host: "dsh", sessionId: agent.id }, signal);
      check(); signal.throwIfAborted(); requireThat(valid(result), "历史输出不符合契约。"); return json(result);
    },
  });
}
