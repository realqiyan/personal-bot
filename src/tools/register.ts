import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallAccess } from "./access.js";
import type { HistoryService } from "../services/history/history-service.js";
import { historyTool } from "./history/pi-tool.js";

export function mainTools(history: HistoryService, access: CallAccess): ToolDefinition[] {
  return [historyTool(history, access)];
}

export class ToolRegistry {
  readonly #registered = new Map<string, ToolDefinition>();
  constructor(private readonly pi: ExtensionAPI) {}
  register(tools: ToolDefinition[]) {
    for (const definition of tools) {
      const tool = { ...definition, namespace: { name: "pbot", description: "工作区历史查询。" } };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}
