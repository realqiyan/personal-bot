import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiAgents, agentDirectory } from "./integrations/pi/pi-agents.js";
import { PythonEnvironmentService } from "./services/workspace/python-environment-service.js";
import { AgentService } from "./services/agents/agent-service.js";
import { TeamService } from "./services/agents/team-service.js";
import { Confirmations } from "./ui/confirmation.js";
import { ToolRegistry, mainTools } from "./tools/register.js";
import { Lifecycle, WorkspaceInstance } from "./extension/lifecycle.js";
import { registerCommand } from "./extension/command.js";
import { registerEvents } from "./extension/events.js";
import { registerAgentEvents } from "./extension/agent-events.js";
import { HistoryService } from "./services/history/history-service.js";
import { HistoryFiles } from "./storage/history-files.js";
import { PiHistory } from "./integrations/pi/history.js";
import { sessionRef } from "./storage/agent-files.js";
import { join } from "node:path";
import { registerHistoryEvents } from "./extension/history.js";

export default function pbot(pi: ExtensionAPI) {
  // The explicitly loaded child entry owns the child; normal discovery never grants main privileges.
  if (process.env.PBOT_SUBAGENT_RUN_ID) return;
  const confirmations = new Confirmations(), registry = new ToolRegistry(pi);
  const lifecycle = new Lifecycle(root => {
    const agents = new AgentService(root, agentDirectory(), new PiAgents());
    const history = new HistoryService(root, new HistoryFiles(join(root, ".pbot/history")), new PiHistory(root, () =>
      agents.files.list().filter(agent => agent.workspace === root).flatMap(agent => {
        const file = agents.files.optional(agent.agentId, "session-ref.json", sessionRef)?.file;
        return file ? [file] : [];
      })), new HistoryFiles(join(root, ".pbot/history"), "dsh"));
    return new WorkspaceInstance(root, new PythonEnvironmentService(root), agents, new TeamService(root, agents.files, agents.teamFiles), history);
  }, instance => registry.register(mainTools(instance.agents, instance.teams, instance.history, instance)), () => registry.hide());
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
  registerAgentEvents(pi, lifecycle, confirmations);
  registerHistoryEvents(pi, lifecycle);
}
