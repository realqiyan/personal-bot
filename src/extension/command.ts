import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { packageVersion } from "../common/version.js";
import { initializeWorkspace } from "../services/workspace/workspace-preparation.js";
import { workspaceDisabledMessage } from "../services/workspace/workspace-config.js";
import { agentOwner } from "../integrations/pi/agent-context.js";
import { tmuxName } from "../integrations/pi/pi-agents.js";
import type { Confirmations } from "../ui/confirmation.js";
import { agentSummary } from "../ui/agent-display.js";
import type { Lifecycle, WorkspaceInstance } from "./lifecycle.js";

async function enterAgent(instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations, query: string) {
  instance.check();
  if (ctx.mode !== "tui") { ctx.ui.notify("进入专家会话需要在交互终端（TUI）中使用。", "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理待确认操作。", "info"); return; }
  const owner = () => agentOwner(ctx);
  const native = instance.agents.list(owner()).filter(value => value.owned && value.transport !== "acp");
  if (!native.length) { ctx.ui.notify("还没有可进入的 Pi 原生专家会话。", "info"); return; }
  let picked = native[0];
  const target = query.trim();
  if (target) {
    const matches = native.filter(value => value.agentId === target || value.agentId.startsWith(target) || value.name === target);
    if (!matches.length) { ctx.ui.notify("未找到匹配的 Pi 原生专家：" + target, "error"); return; }
    if (matches.length > 1) { ctx.ui.notify("匹配到多位专家，请指定更完整的 ID 或名称。", "error"); return; }
    picked = matches[0];
  } else {
    const options = native.map(value => agentSummary(value) + (value.alive ? "" : " · 待命"));
    const selected = await ctx.ui.select("进入专家会话", options);
    picked = native[options.indexOf(selected ?? "")];
  }
  if (!picked) return;
  const inTmux = Boolean(process.env.TMUX);
  ctx.ui.notify(`返回主会话：Ctrl+B → ${inTmux ? "l" : "d"}`, "info");
  let tui: TUI | undefined;
  await ctx.ui.custom<void>((terminal, _theme, _keys, done) => { tui = terminal; queueMicrotask(() => done()); return new Text("", 0, 0); });
  if (!tui) return;
  instance.check();
  await instance.agents.enter(picked.agentId, owner());
  const terminal = tui;
  terminal.stop();
  try {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn("tmux", [inTmux ? "switch-client" : "attach-session", "-t", "=" + tmuxName(picked.agentId)], { stdio: "inherit" });
      child.on("error", () => resolve(null));
      child.on("close", resolve);
    });
    if (code !== 0) ctx.ui.notify("无法进入专家会话。", "error");
  } finally {
    terminal.start();
    terminal.requestRender(true);
  }
}

export function registerCommand(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.registerCommand("pbot", {
    description: "工作区初始化、状态与进入专家会话",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix)) return null;
      return ["init", "status", "enter"]
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
        const agents = instance.agents.list(agentOwner(ctx)), history = instance.history.status;
        ctx.ui.notify([
          `工作区  ${instance.root}`,
          `状态    已启动 · 版本 ${packageVersion}`,
          `专家    ${agents.length} 位 · ${agents.filter(value => value.alive).length} 位存活`,
          `历史    ${history.organizing ? "整理中" : history.pending === null ? "查询时更新索引" : history.pending + " 项待整理"}`,
          ...history.warnings,
        ].join("\n"), "info");
        return;
      }
      if (command === "enter") {
        await enterAgent(instance, ctx, confirmations, argument);
        return;
      }
      ctx.ui.notify("/pbot init | status | enter [专家]", "info");
    },
  });
}
