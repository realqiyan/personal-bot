import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import type { WorkspaceInstance } from "./lifecycle.js";
import { agentOwner } from "../integrations/pi/agent-context.js";
import { tmuxName } from "../integrations/pi/pi-agents.js";
import { agentSummary } from "../ui/agent-display.js";
import { readPage } from "../ui/pi/reader.js";
import { choose } from "../ui/pi/menu.js";
import { stateLabel } from "../ui/presentation.js";
import type { Confirmations } from "../ui/confirmation.js";

export async function showAgents(_pi: ExtensionAPI, instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations, agentIds?: string[]) {
  instance.check();
  const owner = () => agentOwner(ctx), views = () => instance.agents.list(owner()).filter(v => !agentIds || agentIds.includes(v.agentId));
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify(views()), "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理待确认操作。", "info"); return; }
  for (;;) {
    instance.check(); const values = views();
    if (!values.length) { ctx.ui.notify("还没有专家。告诉主助手需要什么专家即可创建。", "info"); return; }
    const options = values.map(v => agentSummary(v) + (v.owned ? "" : " · 其他分支"));
    const selected = await choose(ctx, "专家", options), picked = values[options.indexOf(selected ?? "")]; if (!picked) return;
    if (!picked.owned) { ctx.ui.notify("请返回所属分支操作。", "info"); continue; }
    for (;;) {
      instance.check(); const value = instance.agents.status(picked.agentId, owner()), inTmux = Boolean(process.env.TMUX);
      const enterTui = value.alive ? "进入会话" : "打开原会话（待命）";
      const action = await choose(ctx, `${value.name} · ${stateLabel(value.state)}`, [enterTui, "详情", ...(value.alive ? ["补充要求"] : []), "重命名", ...(value.alive ? ["停止"] : [])]);
      if (!action) break;
      instance.check();
      try {
        if (action === "详情") {
          await readPage(ctx, value.name, [`状态  ${stateLabel(value.state)}`, `活动  ${value.activity}`, `模型  ${value.options.provider}/${value.options.model}`,
            `目录  ${value.cwd}`, `ID    ${value.agentId}`, ...(value.error ? ["", value.error] : []), "", `返回主会话：Ctrl+B → ${inTmux ? "l" : "d"}`].join("\n")); continue;
        }
        if (action === "停止") { instance.agents.stop(value.agentId, owner()); ctx.ui.notify("已请求停止。", "info"); continue; }
        if (action === "重命名") {
          const name = await ctx.ui.input("新名称", value.name); instance.check();
          if (name?.trim()) { instance.agents.rename(value.agentId, name.trim(), owner()); ctx.ui.notify("名称已更新。", "info"); } continue;
        }
        if (action === "补充要求") {
          const message = await ctx.ui.editor("补充要求"); instance.check();
          if (message?.trim()) { instance.agents.send(value.agentId, message, "steer", owner()); ctx.ui.notify("要求已排队。", "info"); } continue;
        }
        if (action !== enterTui) continue;
        ctx.ui.notify(`返回主会话：Ctrl+B → ${inTmux ? "l" : "d"}`, "info");
        let tui: TUI | undefined;
        await ctx.ui.custom<void>((terminal, _theme, _keys, done) => { tui = terminal; queueMicrotask(() => done()); return new Text("", 0, 0); });
        if (!tui) return;
        instance.check(); await instance.agents.enter(value.agentId, owner()); const terminal = tui; terminal.stop();
        try {
          const code = await new Promise<number | null>(resolve => {
            const child = spawn("tmux", [inTmux ? "switch-client" : "attach-session", "-t", "=" + tmuxName(value.agentId)], { stdio: "inherit" });
            child.on("error", () => resolve(null)); child.on("close", resolve);
          });
          if (code !== 0) ctx.ui.notify("无法进入专家会话。", "error");
        } finally { terminal.start(); terminal.requestRender(true); }
        return;
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }
}
