import { resourceRoot } from "../common/paths.js";
import { packageVersion } from "../common/version.js";
import { requireThat } from "../common/validation.js";
import { loadWorkspaceContext } from "../integrations/agent-resources.js";
import type { PluginHostAdapter } from "../model/plugin-host.js";
import { readWorkspaceConfig } from "../services/workspace/workspace-config.js";
import { initializeWorkspace } from "../services/workspace/workspace-preparation.js";

function disabledMessage(adapter: PluginHostAdapter, configuration: Awaited<ReturnType<typeof readWorkspaceConfig>>) {
  return configuration.error ?? `Personal Bot 未在此工作区启用。运行 ${adapter.initCommandHint}；配置文件：${configuration.path}`;
}

export async function pluginCommand(adapter: PluginHostAdapter, args: readonly string[], cwd: string) {
  const root = await adapter.resolveRoot(cwd);
  const action = args.join(" ");
  requireThat(["init", "status"].includes(action), adapter.usage);
  if (action === "init") await initializeWorkspace(root);
  const configuration = await readWorkspaceConfig(root);
  return { version: packageVersion, workspaceRoot: root, resourceRoot, configuration };
}

export async function runPluginHost(adapter: PluginHostAdapter, args: readonly string[]): Promise<void> {
  if (args[0] === "hook") {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += String(chunk);
    process.stdout.write(JSON.stringify(await pluginHook(adapter, JSON.parse(input))) + "\n");
  } else {
    process.stdout.write(JSON.stringify(await pluginCommand(adapter, args, process.cwd()), null, 2) + "\n");
  }
}

/** Shared hook execution engine; host-specific protocols stay in PluginHostAdapter implementations. */
export async function pluginHook(adapter: PluginHostAdapter, payload: unknown): Promise<Record<string, unknown>> {
  if (process.env.PBOT_SUBAGENT_RUN_ID) return adapter.formatPass(payload);
  const event = adapter.parseEvent(payload);
  if (event.kind === "ignore") return adapter.formatPass(payload);
  const root = await adapter.resolveRoot(event.cwd, event.raw);
  const configuration = await readWorkspaceConfig(root);
  if (event.kind === "check-skill") {
    if (configuration.enabled) return adapter.formatPass(payload);
    return adapter.formatDeny(event, disabledMessage(adapter, configuration));
  }
  if (!configuration.enabled) return adapter.formatPass(payload);
  if (event.kind === "subagent-call") {
    if (!adapter.formatSubagentCall) return adapter.formatPass(payload);
    const context = await loadWorkspaceContext({
      host: adapter.host,
      root,
      role: "general-purpose",
      includeRootAgents: !adapter.nativeRootAgents,
      localRoleOnly: true,
    });
    return adapter.formatSubagentCall(event, context.text);
  }
  const context = await loadWorkspaceContext({
    host: adapter.host,
    root,
    role: event.role,
    includeRootAgents: !adapter.nativeRootAgents,
    ...(event.localRoleOnly ? { localRoleOnly: true } : {}),
  });
  return adapter.formatContext(event, context);
}
