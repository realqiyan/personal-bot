import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { json } from "../../../common/json.js";
import { requireThat } from "../../../common/validation.js";
import { createAcpHistorySummarizer } from "../../../integrations/acp/history-summary.js";
import { migrateWorkspaceHistory } from "../../../services/history/history-migrate.js";
import { parseHistoryCommand } from "../../../services/history/summary-command.js";
import { listSummaryDimensions } from "../../../services/history/summary-registry.js";
import { inspectWorkspaceSummaries, runWorkspaceSummaries } from "../../../services/history/summary-runner.js";
import { readWorkspaceConfig, readWorkspaceHistoryLayoutSync, workspaceDisabledMessage, workspaceSummaryConfig } from "../../../services/workspace/workspace-config.js";
import { dshWorkspaceStatus, type PbotManagement } from "./management.js";
import type { DshWorkspaces } from "./workspace.js";
import { parseWorkerCommand } from "../../mcp/workers.js";

const usage = '用法：/pbot status | init | history [summary [维度] [--force] [--backend <acp>] [--model <model>] | migrate [--dry-run] | status | list | {"action":…}] | worker [overview|status|backends|models|create|request|response|output|close] [JSON]';

export function registerDshCommand(ctx: Context, workspaces: DshWorkspaces, management: PbotManagement) {
  ctx.commands.register({
    name: "pbot",
    description: "Personal Bot 工作区、历史摘要与跨 Harness worker 管理",
    recordInput: false,
    input: { hint: "status | init | history ... | worker ...", attachments: false },
    async handler({ agent, rawInput, signal }) {
      signal.throwIfAborted();
      const command = rawInput.trim(), split = command.search(/\s/);
      if (!command || command === "status") {
        const status = await dshWorkspaceStatus(workspaces, agent);
        signal.throwIfAborted(); return { kind: "success", text: JSON.stringify(status, null, 2) };
      }
      if (command === "init") {
        await workspaces.initialize(agent);
        signal.throwIfAborted();
        return { kind: "success", text: JSON.stringify(await dshWorkspaceStatus(workspaces, agent), null, 2) };
      }
      const workspace = await workspaces.get(agent);
      signal.throwIfAborted();
      const verb = split < 0 ? command : command.slice(0, split);
      const rest = split < 0 ? "" : command.slice(split).trim();
      let result: unknown;
      switch (verb) {
        case "worker": {
          const { tool, args } = parseWorkerCommand(rest);
          result = await workspace.workers.callTool(tool, { workspace: workspace.root, ...args });
          break;
        }
        case "history": {
          requireThat(workspace.features.history, "当前工作区已停用历史功能（features.history: false）。");
          const parsed = parseHistoryCommand(rest);
          if (parsed.kind === "status") {
            result = inspectWorkspaceSummaries(workspace.root);
          } else if (parsed.kind === "list") {
            const layout = readWorkspaceHistoryLayoutSync(workspace.root);
            result = { layout, dimensions: listSummaryDimensions(layout).map(({ id, title, description }) => ({ id, title, description })) };
          } else if (parsed.kind === "migrate") {
            result = migrateWorkspaceHistory(workspace.root, { dryRun: parsed.dryRun });
          } else if (parsed.kind === "query") {
            result = await management.history({ parentSessionId: agent.id, input: json(parsed.input) }, signal);
          } else {
            const active = AbortSignal.any([signal, workspace.lifetime.signal]);
            const config = await readWorkspaceConfig(workspace.root);
            requireThat(config.enabled && !config.error, workspaceDisabledMessage(config));
            const summaryCfg = workspaceSummaryConfig(config);
            const backend = parsed.backend ?? summaryCfg.backend;
            const model = parsed.model ?? summaryCfg.model;
            const thinking = parsed.thinking ?? summaryCfg.thinking;
            const summarizer = createAcpHistorySummarizer({
              cwd: workspace.root,
              backend,
              ...(config.acp ? { commands: config.acp } : {}),
              ...(model ? { model } : {}),
              ...(thinking ? { thinking } : {}),
            });
            const report = await runWorkspaceSummaries({
              root: workspace.root,
              summarizer,
              ...(parsed.dimensions ? { dimensions: parsed.dimensions } : {}),
              force: parsed.force,
              ...(summaryCfg.concurrency !== undefined ? { concurrency: summaryCfg.concurrency } : {}),
              signal: active,
            });
            result = { backend, ...(model ? { model } : {}), ...report };
          }
          break;
        }
        default:
          throw new Error(usage);
      }
      workspace.check();
      return { kind: "success", text: JSON.stringify(result, null, 2) };
    },
  });
}
