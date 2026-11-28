import { join } from "node:path";
import { resourceRoot } from "../../common/paths.js";
import { packageVersion } from "../../common/version.js";
import { requireThat } from "../../common/validation.js";
import { loadWorkspaceContext } from "../../integrations/agent-resources.js";
import type { PluginHostAdapter } from "../../model/plugin-host.js";
import { recordHistoryCapture } from "../../services/history/history-capture.js";
import { checkHistoryMigrationNotice } from "../../services/history/history-migrate.js";
import { checkHistorySummaryReminder } from "../../services/history/summary-runner.js";
import { readWorkspaceConfig, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { initializeWorkspace } from "../../services/workspace/workspace-preparation.js";
import { discoverSkills, discoverWorkspaceSkills } from "../../services/workspace/workspace-skills.js";

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
  const features = workspaceFeatures(configuration);
  if (event.kind === "check-skill") {
    if (!configuration.enabled) return adapter.formatDeny(event, disabledMessage(adapter, configuration));
    if (!features.skills) return adapter.formatDeny(event, `Personal Bot 工作区技能已在 ${configuration.path} 中停用（features.skills: false）。`);
    return adapter.formatPass(payload);
  }
  if (!configuration.enabled) return adapter.formatPass(payload);
  if (features.history && adapter.extractHistory) {
    try {
      const capture = await adapter.extractHistory(event);
      if (capture) recordHistoryCapture(root, adapter.host, capture);
    } catch { /* Never block a host turn if history persistence encounters a transient error or busy lock. */ }
  }
  if (event.kind === "record-history") return adapter.formatPass(payload);
  const includePrompts = features.prompts && !event.noticesOnly;
  const includeSkills = features.skills && !event.noticesOnly;
  const workspaceSkills = includeSkills && !adapter.nativeWorkspaceSkills
    ? await discoverWorkspaceSkills(root)
    : [];
  if (includeSkills && adapter.indexBundledSkills) {
    const directory = join(resourceRoot, "skills");
    workspaceSkills.push(...await discoverSkills(directory, directory));
  }
  const notices: string[] = [];
  if (event.isSessionStart && features.history) {
    try {
      const migrationNotice = checkHistoryMigrationNotice(root);
      if (migrationNotice) notices.push(migrationNotice);
      const reminder = checkHistorySummaryReminder(root);
      if (reminder) notices.push(reminder.message);
    } catch { /* Never block session start if history reminder probe fails. */ }
  }
  if (!includePrompts && !workspaceSkills.length && !notices.length) return adapter.formatPass(payload);
  const context = await loadWorkspaceContext({
    host: adapter.host,
    root,
    role: event.role,
    ...(adapter.coordinatorPrompt ? { coordinatorPrompt: adapter.coordinatorPrompt } : {}),
    includePrompts,
    includeRootAgents: includePrompts && !adapter.nativeRootAgents,
    ...(event.localRoleOnly ? { localRoleOnly: true } : {}),
    workspaceSkills,
    notices,
  });
  return adapter.formatContext(event, context);
}
