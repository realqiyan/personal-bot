import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentOwner } from "../integrations/pi/agent-context.js";
import type { WorkspaceInstance } from "./lifecycle.js";
import type { Confirmations } from "../ui/confirmation.js";
import { showAgents } from "./agents-command.js";

export async function showTeams(pi: ExtensionAPI, instance: WorkspaceInstance, ctx: ExtensionCommandContext, confirmations: Confirmations) {
  instance.check();
  const owner = () => agentOwner(ctx), views = () => instance.agents.list(owner()), service = instance.teams;
  service.recover(owner());
  const values = service.list(owner(), views());
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify({ teams: values }), "info"); return; }
  if (confirmations.presenting) { ctx.ui.notify("请先处理主会话批准。", "info"); return; }
  if (!values.length) { ctx.ui.notify("没有团队；先用 pbot_agent start 创建成员，再用 pbot_team create 组队。", "info"); return; }
  const options = values.map(v => v.name + (v.owned ? " · " + (v.closed ? "closed" : v.run?.state ?? "open") + " · 在途 " + v.activeCount : " · 其他分支"));
  const selected = await ctx.ui.select("pbot 团队", options), value = values[options.indexOf(selected ?? "")];
  if (!value) return;
  if (!value.owned) { ctx.ui.notify("请返回所属分支操作。", "info"); return; }
  const action = await ctx.ui.select(value.name, ["状态", "公共记录", "发布信息", "新批次", "暂停", "关闭", "成员 TUI/报告"]);
  instance.check();
  if (action === "状态") { ctx.ui.notify(JSON.stringify(service.status(value.teamId, owner(), views()), null, 2), "info"); return; }
  if (action === "成员 TUI/报告") { await showAgents(pi, instance, ctx, confirmations, value.members.map(m => m.agentId)); return; }
  if (action === "暂停") { service.pause(value.teamId, owner()); return; }
  if (action === "关闭") { service.close(value.teamId, owner(), views()); return; }
  if (action === "发布信息") {
    const text = await ctx.ui.editor("公开给全体成员（不会唤醒模型）");
    instance.check();
    if (text?.trim()) service.post(value.teamId, { kind: "user", owner: owner() }, randomUUID(), text);
    return;
  }
  if (action === "新批次") {
    const mode = await ctx.ui.select("协作策略", ["roundRobin", "parallel"]);
    if (mode !== "roundRobin" && mode !== "parallel") return;
    const instruction = await ctx.ui.editor("本批次要求；不要把新批次当作未知外部操作的重试");
    if (!instruction?.trim()) return;
    const rounds = await ctx.ui.input("轮数 1–10；期限默认 15 分钟", "2");
    if (rounds === undefined) return;
    instance.check();
    service.run(value.teamId, owner(), { instruction, mode, rounds: rounds.trim() ? Number(rounds) : 2 }, views());
    return;
  }
  if (action !== "公共记录") return;
  let page: { afterSeq?: number; seq?: number; offset?: number } = {};
  for (;;) {
    instance.check();
    const data = service.read(value.teamId, { kind: "user", owner: owner() }, page);
    await ctx.ui.editor("公共记录（查看不领取模型通知）", data.messages.map(m =>
      "#" + m.seq + " " + m.author.name + (m.replyTo ? " → #" + m.replyTo : "") + "\n" + m.text +
      (m.nextOffset === null ? "" : "\n[本条未完，字符 " + m.nextOffset + "/" + m.totalLength + "]")).join("\n\n") || "尚无消息");
    const last = data.messages.at(-1);
    if (last?.nextOffset !== null && last?.nextOffset !== undefined) {
      if (await ctx.ui.select("继续阅读", ["本条后续", "返回"]) !== "本条后续") return;
      page = { seq: last.seq, offset: last.nextOffset };
    } else if (last && last.seq < data.lastSeq) {
      if (await ctx.ui.select("继续阅读", ["后续消息", "返回"]) !== "后续消息") return;
      page = { afterSeq: last.seq };
    } else return;
  }
}
