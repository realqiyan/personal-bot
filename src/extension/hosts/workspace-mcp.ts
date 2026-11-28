import type { ResolvedWorkspaceMcpServer } from "../../model/workspace-mcp.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "../../services/workspace/workspace-mcp.js";

/** A native host can keep its other tools when one workspace server cannot be mounted. */
export async function loadNativeWorkspaceServers(
  root: string,
  mount: (server: ResolvedWorkspaceMcpServer) => void | Promise<void>,
  options: { check?: () => void; warn?: (message: string) => void } = {},
) {
  const config = await readWorkspaceMcpConfig(root);
  options.check?.();
  if (config.error) {
    options.warn?.(config.error);
    return;
  }
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled === false) continue;
    options.check?.();
    try {
      await mount(resolveWorkspaceMcpServer(root, name, server));
    } catch (error) {
      options.warn?.(error instanceof Error ? error.message : String(error));
    }
  }
}
