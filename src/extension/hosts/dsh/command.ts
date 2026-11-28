import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { dshWorkspaceStatus } from "./management.js";
import type { DshWorkspaces } from "./workspace.js";
import { runHistoryCommand } from "../history-command.js";
import { parseWorkerCommand } from "../../mcp/workers.js";

const usage = '用法：/pbot status | init | history [summary [维度] [--force] [--backend <acp>] [--model <model>] | migrate [--dry-run] | status | list | {"action":…}] | worker [overview|status|backends|models|create|request|response|output|close] [JSON]';

export function registerDshCommand(ctx: Context, workspaces: DshWorkspaces) {
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
          const active = AbortSignal.any([signal, workspace.lifetime.signal]);
          result = await runHistoryCommand(workspace, rest, active);
          active.throwIfAborted();
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
