import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentOwner } from "../integrations/pi/agent-context.js";
import type { WorkspaceInstance } from "./lifecycle.js";
import type { Confirmations } from "../ui/confirmation.js";
import { readPage } from "../ui/pi/reader.js";
import { choose } from "../ui/pi/menu.js";
import { stateLabel } from "../ui/presentation.js";
import { showAgents } from "./agents-command.js";

export async function showTeams(pi: ExtensionAPI, instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations) {
  instance.check();
  const owner = () => agentOwner(ctx), views = () => instance.agents.list(owner()), service = instance.teams;
  service.recover(owner());
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify({ teams: service.list(owner(), views()) }), "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理待确认操作。", "info"); return; }
  for (;;) {
    instance.check(); const values = service.list(owner(), views());
    if (!values.length) { ctx.ui.notify("还没有团队。请主助手为已有专家组队。", "info"); return; }
    const options = values.map(v => v.name + " · " + (v.owned ? stateLabel(v.closed ? "closed" : v.run?.state ?? "open") + " · 在途 " + v.activeCount : "其他分支"));
    const selected = await choose(ctx, "团队", options), picked = values[options.indexOf(selected ?? "")]; if (!picked) return;
    if (!picked.owned) { ctx.ui.notify("请返回所属分支操作。", "info"); continue; }
    for (;;) {
      instance.check(); const value = service.status(picked.teamId, owner(), views()); if (!value.owned) break;
      const action = await choose(ctx, value.name + " · " + stateLabel(value.closed ? "closed" : value.run?.state ?? "open"),
        ["状态", "公共记录", "成员会话", ...(!value.closed ? ["发布消息", ...(value.run?.state === "running" ? ["暂停"] : ["新批次"]), "关闭团队"] : [])]);
      if (!action) break;
      instance.check();
      try {
        if (action === "状态") {
          const run = value.run;
          await readPage(ctx, value.name, [value.brief, "", ...value.members.map(member => `${member.name} · ${member.role} · ${stateLabel(member.state)}`), "",
            ...(run ? [`批次  ${stateLabel(run.state)} · ${run.mode === "parallel" ? "并行" : "轮流"} · ${run.rounds} 轮`,
              `进展  已安排 ${run.scheduled} · 已交付 ${run.published} · 在途 ${value.activeCount}`, ...(run.reason ? [run.reason] : [])] : ["尚无批次"])].join("\n"));
        } else if (action === "成员会话") await showAgents(pi, instance, ctx, confirmations, value.members.map(m => m.agentId));
        else if (action === "暂停") { service.pause(value.teamId, owner()); ctx.ui.notify("已暂停新安排。", "info"); }
        else if (action === "关闭团队") { service.close(value.teamId, owner(), views()); ctx.ui.notify("团队已关闭。", "info"); }
        else if (action === "发布消息") {
          const text = await ctx.ui.editor("公共消息"); instance.check();
          if (text?.trim()) { service.post(value.teamId, { kind: "user", owner: owner() }, randomUUID(), text); ctx.ui.notify("消息已发布。", "info"); }
        } else if (action === "新批次") {
          const strategy = await ctx.ui.select("讨论模式", ["轮流讨论", "并行轮次"]); if (!strategy) continue;
          const instruction = await ctx.ui.editor("任务与交付要求"); if (!instruction?.trim()) continue;
          const rounds = await ctx.ui.input("轮数（1–10，默认 2）"); if (rounds === undefined) continue;
          instance.check(); service.run(value.teamId, owner(), { instruction, mode: strategy === "并行轮次" ? "parallel" : "roundRobin", rounds: rounds.trim() ? Number(rounds) : 2 }, views());
          ctx.ui.notify("新批次已开始。", "info");
        } else if (action === "公共记录") await messages(value.teamId);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  }
  async function messages(teamId: string) {
    let page: { afterSeq?: number; seq?: number; offset?: number } = {};
    for (;;) {
      instance.check(); const data = service.read(teamId, { kind: "user", owner: owner() }, page);
      await readPage(ctx, "公共记录", data.messages.map(message => `#${message.seq} ${message.author.name}${message.replyTo ? ` → #${message.replyTo}` : ""}\n${message.text}` +
        (message.nextOffset === null ? "" : `\n[未完 · ${message.nextOffset}/${message.totalLength}]`)).join("\n\n") || "尚无消息。");
      const last = data.messages.at(-1);
      if (last?.nextOffset !== null && last?.nextOffset !== undefined) {
        if (await ctx.ui.select("公共记录", ["继续本条", "返回"]) !== "继续本条") return;
        page = { seq: last.seq, offset: last.nextOffset };
      } else if (last && last.seq < data.lastSeq) {
        if (await ctx.ui.select("公共记录", ["后续消息", "返回"]) !== "后续消息") return;
        page = { afterSeq: last.seq };
      } else return;
    }
  }
}
