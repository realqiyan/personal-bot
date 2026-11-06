import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../services/agents/agent-service.js";
import type { CallAccess } from "./access.js";
import { agentTool } from "./agents/tool.js";
import type { TeamService } from "../services/agents/team-service.js";
import { teamTool, teamMessageTool } from "./teams/tool.js";
import { agentOwner } from "../integrations/pi/agent-context.js";
import type { HistoryService } from "../services/history/history-service.js";
import { historyTool } from "./history/tool.js";

export function mainTools(agents: AgentService, teams: TeamService, history: HistoryService, access: CallAccess): ToolDefinition[] {
  return [agentTool(agents, access), teamTool(teams, agents, access), teamMessageTool(teams, access, ctx => ({ kind: "coordinator", owner: agentOwner(ctx) })), historyTool(history, access)];
}
export class ToolRegistry {
  readonly #registered = new Map<string, ToolDefinition>();
  constructor(private readonly pi: ExtensionAPI) {}
  register(tools: ToolDefinition[]) {
    for (const definition of tools) {
      const tool = { ...definition, namespace: { name: "pbot", description: "历史查询、专家与团队协作。" } };
      this.#registered.set(tool.name, tool); this.pi.registerTool(tool);
    }
  }
  hide() {
    for (const tool of this.#registered.values()) this.pi.registerTool({ ...tool, exposure: "hidden" });
  }
}
