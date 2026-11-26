import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "./common/paths.js";
import { Confirmations } from "./ui/confirmation.js";
import { ToolRegistry, mainTools } from "./tools/register.js";
import { Lifecycle, WorkspaceInstance } from "./extension/lifecycle.js";
import { registerCommand } from "./extension/command.js";
import { registerEvents } from "./extension/events.js";
import { registerHistoryEvents } from "./extension/history.js";
import { McpWorkerRuntime, defaultWorkerDirectory } from "./extension/mcp-workers.js";
import { HistoryService } from "./services/history/history-service.js";
import { workspaceFeatures } from "./services/workspace/workspace-config.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "./services/workspace/workspace-mcp.js";
import { HistoryFiles } from "./storage/history-files.js";
import { PiHistory } from "./integrations/pi/history.js";
import { toPiMcpConfig } from "./integrations/pi/mcp.js";
import { acpHistorySessions } from "./storage/acp-history.js";

const mcpServerName = "pbot";

export default function pbot(pi: ExtensionAPI) {
  // The explicitly loaded child entry owns the child; normal discovery never grants main privileges.
  if (process.env.PBOT_SUBAGENT_RUN_ID) return;
  const confirmations = new Confirmations();
  const registry = new ToolRegistry(pi);
  const mcpEntry = resolve(resourceRoot, "../lib/extension/mcp.js");
  const registeredMcpServers: string[] = [];

  const lifecycle = new Lifecycle(
    (root, sessionId, configuration) => {
      const workerDir = defaultWorkerDirectory();
      const workers = new McpWorkerRuntime(workerDir, sessionId, "pi");
      const history = new HistoryService(
        root,
        new HistoryFiles(join(root, ".pbot/history"), "pi"),
        new PiHistory(root),
        [new HistoryFiles(join(root, ".pbot/history"), "dsh"), new HistoryFiles(join(root, ".pbot/history"), "claude")],
        () => acpHistorySessions({ mcp: workerDir }),
      );
      return new WorkspaceInstance(root, sessionId, history, workers, workspaceFeatures(configuration));
    },
    async instance => {
      registry.register(mainTools(instance.history, instance));
      if (existsSync(mcpEntry)) {
        pi.registerMcpServer(mcpServerName, {
          type: "stdio",
          command: process.execPath,
          args: [mcpEntry],
          env: {
            PBOT_HOST: "pi",
            PBOT_WORKSPACE_ROOT: instance.root,
            PBOT_MCP_AGENT_DIR: defaultWorkerDirectory(),
            PBOT_MCP_SESSION_ID: instance.sessionId,
          },
          exposure: "direct",
          timeout: 600,
          description: "跨代理程序委派（worker_*）与工作区统一 MCP 桥接（workspace_mcp_*）",
        });
        registeredMcpServers.push(mcpServerName);
      }
      if (instance.features.mcp) {
        const mcpConfig = await readWorkspaceMcpConfig(instance.root);
        instance.check();
        if (!mcpConfig.error) {
          for (const [name, server] of Object.entries(mcpConfig.servers)) {
            if (server.enabled === false) continue;
            try {
              const resolved = resolveWorkspaceMcpServer(instance.root, name, server);
              pi.registerMcpServer(resolved.name, toPiMcpConfig(resolved));
              registeredMcpServers.push(resolved.name);
            } catch { /* Keep the workspace active even if one external MCP env var is unset. */ }
          }
        }
      }
    },
    () => {
      registry.hide();
      for (const name of registeredMcpServers.splice(0)) {
        pi.unregisterMcpServer(name);
      }
    },
  );
  registerCommand(pi, lifecycle, confirmations);
  registerEvents(pi, lifecycle, confirmations);
  registerHistoryEvents(pi, lifecycle);
}
