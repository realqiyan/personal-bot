import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import type { AgentService } from "../services/agents/agent-service.js";
import type { CallAccess } from "./access.js";
import { agentTool } from "./agents/tool.js";

export function mainTools(agents: AgentService, access: CallAccess): ToolDefinition[] {
  return [agentTool(agents, access)];
}
export class ToolRegistry {
  readonly #registered = new Map<string, ToolDefinition>();
  constructor(private readonly pi: ExtensionAPI) {}
  register(tools: ToolDefinition[]) {
    const promptGuidelines = readFileSync(join(resourceRoot, "prompts/tool-guidelines.md"), "utf8")
      .trim().split(/\r?\n\s*\r?\n/);
    for (const definition of tools) {
      const tool = { ...definition, namespace: { name: "pbot", description: "Personal Bot 独立子会话工具。" },
        promptGuidelines };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}
