import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageVersion } from "../common/version.js";
import { prepareWorkspace } from "../services/workspace/workspace-preparation.js";
import type { Confirmations } from "../ui/confirmation.js";
import { readPage } from "../ui/pi/reader.js";
import { choose } from "../ui/pi/menu.js";
import { stateLabel } from "../ui/presentation.js";
import { agentOwner } from "../integrations/pi/agent-context.js";
import type { Lifecycle } from "./lifecycle.js";
import { showAgents } from "./agents-command.js";
import { showTeams } from "./teams-command.js";
import { showHistory } from "./history.js";

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("pbot", {
    description: "工作区、专家、团队与历史",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      return ["init", "status", "history", "agents", "teams", "python"]
        .filter(command => command.startsWith(prefix)).map(command => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const [, command, argument = ""] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      confirmations.resume();
      async function execute(command: string | undefined, argument: string) {
        const instance = lifecycle.get();
        if (command === "init" && !argument) {
          await ctx.waitForIdle(); instance.check(); await prepareWorkspace(instance.root);
          ctx.ui.notify("资料目录已准备。新建的 AGENTS.md 在 /reload 或下次启动后由 Pi 加载。", "info"); return;
        }
        if (command === "status" && !argument) {
          const python = instance.pythonEnvironment.status;
          if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify({ workspaceRoot: instance.root, release: packageVersion, python }, null, 2), "info"); return; }
          const agents = instance.agents.list(agentOwner(ctx)), history = instance.history.status;
          await readPage(ctx, "工作区", [instance.root, "", `版本    ${packageVersion}`,
            `模型    ${ctx.model && !(ctx.model.provider === "unknown" && ctx.model.id === "unknown") ? ctx.model.provider + "/" + ctx.model.id : "未选择"}`,
            `专家    ${agents.length} 位 · ${agents.filter(value => value.alive).length} 位存活`,
            `Python  ${stateLabel(python.state)}`, ...(python.directory ? [python.directory] : []), ...(python.error ? ["", python.error] : []),
            "", `历史    ${history.organizing ? "整理中" : history.pending === null ? "查询时更新索引" : history.pending + " 项待整理"}`,
            ...history.warnings].join("\n")); return;
        }
        if (command === "history") { await showHistory(instance, ctx, argument); return; }
        if (command === "agents") { await showAgents(pi, instance, ctx, confirmations); return; }
        if (command === "teams") { await showTeams(pi, instance, ctx, confirmations); return; }
        if (command === "python" && argument === "setup") {
          const cancel = instance.signal(ctx.signal); await ctx.waitForIdle();
          ctx.ui.notify("正在准备 Python…", "info");
          const result = await instance.preparePython(cancel);
          ctx.ui.notify(ctx.mode === "tui" ? "Python 已就绪。" : JSON.stringify(result, null, 2), "info"); return;
        }
        ctx.ui.notify("/pbot init | status | history [关键词] | agents | teams | python setup", "info");
      }
      if (command || ctx.mode !== "tui") { await execute(command, argument); return; }
      if (confirmations.presenting) { ctx.ui.notify("请先处理待确认操作。", "info"); return; }
      for (;;) {
        const instance = lifecycle.get(), agents = instance.agents.list(agentOwner(ctx));
        const choices = ["专家 · " + agents.length, "团队", "历史", "工作区状态", "准备资料目录", "准备 Python"];
        const choice = await choose(ctx, `Personal Bot · Python ${stateLabel(instance.pythonEnvironment.status.state)}`, choices);
        if (!choice) return;
        const command = ["agents", "teams", "history", "status", "init", "python"][choices.indexOf(choice)]!;
        try { await execute(command, command === "python" ? "setup" : ""); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      }
    },
  });
}
