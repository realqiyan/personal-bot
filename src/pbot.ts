import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "./common/paths.js";
import { Confirmations } from "./ui/pi/confirmation.js";
import { ToolRegistry, mainTools } from "./tools/register.js";
import { Lifecycle, WorkspaceInstance } from "./extension/hosts/pi/lifecycle.js";
import { registerCommand } from "./extension/hosts/pi/command.js";
import { registerEvents } from "./extension/hosts/pi/events.js";
import { registerHistoryEvents } from "./extension/hosts/pi/history.js";
import { McpWorkerRuntime, defaultWorkerDirectory } from "./extension/mcp/workers.js";
import { workspaceFeatures } from "./services/workspace/workspace-config.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "./services/workspace/workspace-mcp.js";
import { toPiMcpConfig } from "./integrations/hosts/pi/mcp.js";

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
      return new WorkspaceInstance(root, sessionId, workers, workspaceFeatures(configuration));
    },
    async instance => {
      if (instance.features.history) registry.register(mainTools(instance.root, instance));
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
            PBOT_NATIVE_WORKSPACE_MCP: "1",
            PBOT_NATIVE_HISTORY: "1",
          },
          exposure: "direct",
          timeout: 600,
          description: "跨代理程序委派（worker_*）",
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
