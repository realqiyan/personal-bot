import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HistoryService } from "../../services/history/history-service.js";
import type { CallAccess } from "../access.js";
import { historyLocation } from "../../integrations/pi/history.js";
import { markdownResult } from "../result.js";
import { historyDescription, historyInput, historyParameters, historyResultSchema } from "./contract.js";
import { executeHistory } from "./actions.js";

export function historyTool(service: HistoryService, access: CallAccess) {
  return defineTool({ name: "pbot_history", label: "历史对话", description: historyDescription,
    parameters: historyParameters, outputSchema: historyResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check();
      const result = await executeHistory(service, historyInput(args), historyLocation(ctx), signal);
      access.check();
      return markdownResult(result, args.action === "search" ? "历史搜索" : "历史正文");
    },
  });
}
