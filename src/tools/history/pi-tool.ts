import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markdownResult } from "../result.js";
import { historyDescription, historyInput, historyParameters, historyResultSchema } from "./contract.js";
import { executeHistory } from "./actions.js";

export function registerPiHistoryTool(pi: ExtensionAPI, root: string, access: { check(): void }) {
  const tool = defineTool({
    namespace: { name: "pbot", description: "工作区历史查询。" },
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
  pi.registerTool(tool);
  return () => pi.registerTool({ ...tool, exposure: "hidden" });
}
