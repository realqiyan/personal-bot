import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import type { WorkspaceInstance } from "./lifecycle.js";
import { agentOwner } from "../integrations/pi/agent-context.js";
import { tmuxName } from "../integrations/pi/pi-agents.js";
import { agentSummary } from "../ui/agent-display.js";
import type { Confirmations } from "../ui/confirmation.js";

export async function showAgents(_pi: ExtensionAPI, instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations, agentIds?: string[]) {
  instance.check();
  const owner = () => agentOwner(ctx), values = instance.agents.list(owner()).filter(v => !agentIds || agentIds.includes(v.agentId));
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify(values), "info"); return; }
  if (!values.length) { ctx.ui.notify("没有子会话；用 pbot_agent start 创建。", "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理主会话批准。", "info"); return; }
  const options = values.map(v => agentSummary(v) + (v.owned ? "" : " · 其他分支"));
  const selected = await ctx.ui.select("pbot 子会话", options);
  const value = values[options.indexOf(selected ?? "")]; if (!value) return;
  if (!value.owned) { ctx.ui.notify("请返回所属分支操作。", "info"); return; }
  const inTmux = Boolean(process.env.TMUX);
  const enterTui = "进入 TUI（返回：Ctrl+B → " + (inTmux ? "l" : "d") + "）";
  const action = await ctx.ui.select(value.name, [enterTui, "补充要求", "重命名", "停止"]);
  instance.check();
  if (action === "停止") { instance.agents.stop(value.agentId, owner()); return; }
  if (action === "重命名") { const name = await ctx.ui.input("名称"); instance.check(); if (name?.trim()) instance.agents.rename(value.agentId, name.trim(), owner()); return; }
  if (action === "补充要求") {
    const message = await ctx.ui.editor("任务或补充要求");
    instance.check();
    if (message?.trim()) instance.agents.send(value.agentId, message, "steer", owner());
    return;
  }
  if (action !== enterTui) return;
  let tui: TUI | undefined;
  await ctx.ui.custom<void>((terminal, _theme, _keys, done) => { tui = terminal; queueMicrotask(() => done()); return new Text("", 0, 0); });
  if (!tui) return;
  instance.check();
  instance.agents.enter(value.agentId, owner());
  const terminal = tui;
  terminal.stop();
  try {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn("tmux", [inTmux ? "switch-client" : "attach-session", "-t", "=" + tmuxName(value.agentId)], { stdio: "inherit" });
      child.on("error", () => resolve(null)); child.on("close", resolve);
    });
    if (code !== 0) ctx.ui.notify("无法进入子会话。", "error");
  } finally { terminal.start(); terminal.requestRender(true); }
}
