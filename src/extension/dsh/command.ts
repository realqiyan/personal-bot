import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { object, json } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { dshWorkspaceStatus, type PbotManagement } from "./management.js";
import type { DshWorkspaces } from "./workspace.js";

const usage = '用法：/pbot status | init | worker {"action":…} | history {"action":…}';

export function registerDshCommand(ctx: Context, workspaces: DshWorkspaces, management: PbotManagement) {
  ctx.commands.register({
    name: "pbot",
    description: "Personal Bot 工作区、跨 Harness worker 与历史管理",
    recordInput: false,
    input: { hint: "status | init | worker/history JSON", attachments: false },
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
      requireThat(split >= 0, usage);
      const input: unknown = JSON.parse(command.slice(split));
      requireThat(object(input), "命令参数必须是 JSON 对象。");
      let result: unknown;
      switch (verb) {
        case "worker":
          result = await workspace.workers.callTool("pbot_worker", { workspace: workspace.root, ...input });
          break;
        case "history":
          result = await management.history({ parentSessionId: agent.id, input: json(input) }, signal);
          break;
        default:
          throw new Error(usage);
      }
      workspace.check();
      return { kind: "success", text: JSON.stringify(result, null, 2) };
    },
  });
}
