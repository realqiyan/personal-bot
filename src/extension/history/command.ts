import { requireThat } from "../../common/validation.js";
import { createAcpHistorySummarizer } from "../../integrations/acp/history-summary.js";
import type { SummaryRunProgress } from "../../model/history.js";
import { migrateWorkspaceHistory } from "../../services/history/history-migrate.js";
import { parseHistoryCommand, type ParsedHistoryCommand } from "../../services/history/summary-command.js";
import { listSummaryDimensions } from "../../services/history/summary-registry.js";
import { inspectWorkspaceSummaries, runWorkspaceSummaries } from "../../services/history/summary-runner.js";
import { readWorkspaceConfig, readWorkspaceHistoryLayoutSync, workspaceDisabledMessage, workspaceFeatures, workspaceSummaryConfig } from "../../services/workspace/workspace-config.js";
import { executeHistory } from "../../tools/history/actions.js";
import { historyInput } from "../../tools/history/contract.js";

interface CommandContext {
  root: string;
  features: { history: boolean };
}

export async function runHistoryCommand(
  workspace: CommandContext,
  argument: string | ParsedHistoryCommand,
  signal: AbortSignal,
  progress?: { start(backend: string): void; update(event: SummaryRunProgress): void; finish?(): void },
) {
  const { root } = workspace;
  signal.throwIfAborted();
  requireThat(workspace.features.history, "当前工作区已停用历史功能（features.history: false）。");
  const command = typeof argument === "string" ? parseHistoryCommand(argument) : argument;
  switch (command.kind) {
    case "status":
      return inspectWorkspaceSummaries(root);
    case "list": {
      const layout = readWorkspaceHistoryLayoutSync(root);
      const dimensions = listSummaryDimensions(layout).map(({ id, title, description }) => ({ id, title, description }));
      return { layout, dimensions };
    }
    case "migrate":
      return migrateWorkspaceHistory(root, { dryRun: command.dryRun });
    case "query":
      return executeHistory(root, historyInput(command.input), signal);
    case "summary": {
      const config = await readWorkspaceConfig(root);
      requireThat(config.enabled && !config.error, workspaceDisabledMessage(config));
      requireThat(workspaceFeatures(config).history, "当前工作区已停用历史功能（features.history: false）。");
      const defaults = workspaceSummaryConfig(config);
      const backend = command.backend ?? defaults.backend;
      const model = command.model ?? defaults.model;
      const thinking = command.thinking ?? defaults.thinking;
      const summarizer = createAcpHistorySummarizer({
        cwd: root, backend,
        ...(config.acp ? { commands: config.acp } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      });
      progress?.start(backend);
      try {
        const report = await runWorkspaceSummaries({
          root, summarizer, signal,
          force: command.force,
          concurrency: defaults.concurrency,
          ...(command.dimensions ? { dimensions: command.dimensions } : {}),
          ...(progress ? { onProgress: progress.update } : {}),
        });
        return { backend, ...(model ? { model } : {}), ...report };
      } finally {
        progress?.finish?.();
      }
    }
  }
}
