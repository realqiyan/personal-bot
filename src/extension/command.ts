import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { packageVersion } from "../common/version.js";
import { initializeWorkspace } from "../services/workspace/workspace-preparation.js";
import { workspaceDisabledMessage } from "../services/workspace/workspace-config.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";
import { parseWorkerCommand } from "./mcp-workers.js";

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("pbot", {
    description: "工作区初始化、状态与跨 Harness worker 管理",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      return ["init", "status", "worker"]
        .filter(command => command.startsWith(prefix)).map(command => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const [, command, argument = ""] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
      confirmations.resume();
      if (command === "init" && !argument) {
        await ctx.waitForIdle();
        const start = !lifecycle.active;
        await initializeWorkspace(lifecycle.root ?? ctx.cwd);
        ctx.ui.notify(start ? "工作区已初始化并启用，正在加载 Personal Bot。" : "资料目录已准备；新建的 AGENTS.md 经 /reload 加载。", "info");
        if (start) await ctx.reload();
        return;
      }
      if (!lifecycle.active) {
        const configuration = lifecycle.configuration;
        const status = {
          workspaceRoot: lifecycle.root ?? ctx.cwd,
          release: packageVersion,
          enabled: false,
          state: configuration?.error || configuration?.enabled ? "error" : "disabled",
          nextStep: configuration?.error ?? "/pbot init",
          configuration,
        };
        ctx.ui.notify(command === "status" ? JSON.stringify(status, null, 2)
          : configuration ? workspaceDisabledMessage(configuration) : "pbot 工作区实例不可用。", configuration?.error ? "error" : "info");
        return;
      }
      const instance = lifecycle.get();
      if (command === "status" && !argument) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(JSON.stringify({
            workspaceRoot: instance.root,
            release: packageVersion,
            enabled: true,
            state: "running",
            configuration: lifecycle.configuration,
          }, null, 2), "info");
          return;
        }
        const history = instance.history.status;
        ctx.ui.notify([
          `工作区  ${instance.root}`,
          `状态    已启动 · 版本 ${packageVersion}`,
          `历史    ${history.organizing ? "整理中" : history.pending === null ? "查询时更新索引" : history.pending + " 项待整理"}`,
          ...history.warnings,
        ].join("\n"), "info");
        return;
      }
      if (command === "worker") {
        try {
          const { tool, args: payload } = parseWorkerCommand(argument);
          const result = await instance.workers.callTool(tool, { workspace: instance.root, ...payload });
          ctx.ui.notify(JSON.stringify(result, null, 2), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      ctx.ui.notify('/pbot init | status | worker [overview|status|backends|models|create|request|response|output|close] [JSON]', "info");
    },
  });
}
