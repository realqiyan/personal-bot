import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageVersion } from "../common/version.js";
import { prepareWorkspace } from "../services/workspace/workspace-preparation.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";
import { showAgents } from "./agents-command.js";
import { showTeams } from "./teams-command.js";

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("pbot", {
    description: "工作区：init、status、agents、teams、python setup",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      return ["init", "status", "agents", "teams", "python"]
        .filter(command => command.startsWith(prefix))
        .map(command => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const [, command, argument = ""] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      confirmations.resume();
      if (command === "init" && !argument) {
        await ctx.waitForIdle();
        const instance = lifecycle.get();
        await prepareWorkspace(instance.root);
        ctx.ui.notify("资料目录已准备；已有 AGENTS.md 保持不变。", "info");
        return;
      }
      if (command === "status" && !argument) {
        const instance = lifecycle.get();
        ctx.ui.notify(JSON.stringify({ workspaceRoot: instance.root, release: packageVersion, python: instance.pythonEnvironment.status }, null, 2), "info"); return;
      }
      if (command === "agents") { await showAgents(pi, lifecycle.get(), ctx, confirmations); return; }
      if (command === "teams") { await showTeams(pi, lifecycle.get(), ctx, confirmations); return; }
      if (command === "python" && argument === "setup") {
        const instance = lifecycle.get(), cancel = instance.signal(ctx.signal);
        await ctx.waitForIdle();
        ctx.ui.notify("正在准备共享 Python 环境；安装可能需要数分钟。", "info");
        const result = await instance.preparePython(cancel);
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
        return;
      }
      ctx.ui.notify("用法：/pbot init | status | agents | teams | python setup", "info");
    },
  });
}
