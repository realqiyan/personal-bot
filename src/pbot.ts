import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Confirmations } from "./ui/pi/confirmation.js";
import { registerPiHistoryTool } from "./tools/history/pi-tool.js";
import { Lifecycle, WorkspaceInstance } from "./extension/hosts/pi/lifecycle.js";
import { registerCommand } from "./extension/hosts/pi/command.js";
import { registerEvents } from "./extension/hosts/pi/events.js";
import { registerHistoryEvents } from "./extension/hosts/pi/history.js";
import { McpWorkerRuntime, defaultWorkerDirectory } from "./extension/mcp/workers.js";
import { workspaceFeatures } from "./services/workspace/workspace-config.js";
import { loadNativeWorkspaceServers } from "./extension/hosts/workspace-mcp.js";
import { toPiMcpConfig } from "./integrations/hosts/pi/mcp.js";

const mcpServerName = "pbot";

export default function pbot(pi: ExtensionAPI) {
  // The explicitly loaded child entry owns the child; normal discovery never grants main privileges.
  if (process.env.PBOT_SUBAGENT_RUN_ID) return;
  const confirmations = new Confirmations();
  let hideHistory: (() => void) | undefined;
  const registeredMcpServers: string[] = [];

  const lifecycle = new Lifecycle(
    (root, sessionId, configuration) => {
      const workerDir = defaultWorkerDirectory();
      const workers = new McpWorkerRuntime(workerDir, sessionId, "pi");
      return new WorkspaceInstance(root, sessionId, workers, workspaceFeatures(configuration));
    },
    async instance => {
      if (instance.features.history) hideHistory = registerPiHistoryTool(pi, instance.root, instance);
      const server = instance.workers.nativeServer(instance.root);
      if (server) {
        pi.registerMcpServer(mcpServerName, {
          type: "stdio",
          ...server,
          exposure: "direct",
          timeout: 600,
          description: "跨代理程序委派（worker_*）",
        });
        registeredMcpServers.push(mcpServerName);
      }
      if (instance.features.mcp) {
        await loadNativeWorkspaceServers(instance.root, server => {
          pi.registerMcpServer(server.name, toPiMcpConfig(server));
          registeredMcpServers.push(server.name);
        }, { check: () => instance.check() });
      }
    },
    () => {
      hideHistory?.();
      hideHistory = undefined;
      for (const name of registeredMcpServers.splice(0)) {
        pi.unregisterMcpServer(name);
      }
    },
  );
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
  registerHistoryEvents(pi, lifecycle);
}
