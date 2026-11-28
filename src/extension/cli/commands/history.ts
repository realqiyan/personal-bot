import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { requireThat } from "../../../common/validation.js";
import { parseHistoryCommand, type ParsedHistoryCommand } from "../../../services/history/summary-command.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../../services/workspace/workspace-config.js";
import { printJson, requireNonNegativeInt, resolveCliWorkspace, withSignals } from "../args.js";
import type { CliCommand } from "../types.js";

const historyUsage = `用法：
  pbot history status | list
  pbot history summary [维度...] [--force] [--backend <acp>] [--model <模型>] [--thinking <级别>]
  pbot history migrate [--dry-run]
  pbot history search [关键词] [--host <来源>] [--dimension <维度>] [--session-id <ID>] [--from <时间>] [--to <时间>] [--offset N] [--limit N]
  pbot history read <节点ID> [--host <来源>] [--offset N] [--limit N] [--children-offset N]
所有历史命令支持 --workspace <目录> 和 --json。默认工作区为当前目录。`;

function parseHistoryAction(args: string[]): ParsedHistoryCommand {
  const [action, ...rest] = args;
  if (action !== "search" && action !== "read") return parseHistoryCommand(args);
  const string = { type: "string" } as const;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: string,
      offset: string,
      limit: string,
      ...(action === "search"
        ? { dimension: string, "session-id": string, from: string, to: string }
        : { "children-offset": string }),
    },
  });
  requireThat(positionals.length <= 1 && (action === "search" || positionals[0]), historyUsage);
  const input: Record<string, unknown> = { action };
  if (positionals.length) input[action === "search" ? "query" : "id"] = positionals[0];
  for (const [key, value] of Object.entries(values)) {
    if (["offset", "limit", "children-offset"].includes(key)) {
      input[key === "children-offset" ? "childrenOffset" : key] = requireNonNegativeInt(value, "--" + key);
    } else {
      input[key === "session-id" ? "sessionId" : key] = value;
    }
  }
  return { kind: "query", input };
}

export const historyCommand: CliCommand = {
  name: "history",
  summary: "管理与检索跨宿主工作区历史",
  usage: historyUsage,
  updatePolicy: "workspace",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  beforeUpdate(_ctx, _root, configuration) {
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
    requireThat(workspaceFeatures(configuration).history, "当前工作区已停用历史功能（features.history: false）。");
  },
  async run(ctx) {
    const root = await resolveCliWorkspace(ctx.workspace, ctx.cwd);
    const configuration = await readWorkspaceConfig(root);
    requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
    requireThat(workspaceFeatures(configuration).history, "当前工作区已停用历史功能（features.history: false）。");
    requireThat((await stat(root)).isDirectory(), "工作区必须是目录。");
    const command = parseHistoryAction(ctx.args);
    const outcome = await withSignals(
      async controller => {
        const { runHistoryCommand } = await import("../../history/command.js");
        return runHistoryCommand({ root, features: workspaceFeatures(configuration) }, command, controller.signal, {
          start: backend => console.error("历史摘要生成中 (" + backend + ")"),
          update: event => console.error(`${event.dimension} ${event.completed}/${event.total}`),
        });
      },
      () => console.error("历史操作已取消。"),
    );
    if (!outcome.ok) return outcome.exitCode;
    const result = outcome.value;
    printJson(result, ctx.json);
    if ("backend" in result && result.dimensions.some(dimension => dimension.failed.length)) return 1;
    if ("errors" in result && (result.errors.length || result.skipped.length)) return 1;
    return 0;
  },
};
