import { defineTool } from "@earendil-works/pi-coding-agent";
import type { CallAccess } from "../access.js";
import { markdownResult } from "../result.js";
import { historyDescription, historyInput, historyParameters, historyResultSchema } from "./contract.js";
import { executeHistory } from "./actions.js";

export function historyTool(root: string, access: CallAccess) {
  return defineTool({
    name: "pbot_history",
    label: "历史对话",
    description: historyDescription,
    parameters: historyParameters,
    outputSchema: historyResultSchema,
    async execute(_id, args, signal) {
      access.check();
      const result = executeHistory(root, historyInput(args), signal);
      access.check();
      return markdownResult(result, args.action === "search" ? "历史搜索" : "历史正文");
    },
  });
}
