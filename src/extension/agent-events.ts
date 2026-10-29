import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Lifecycle } from "./lifecycle.js";
import type { Confirmations } from "../ui/confirmation.js";
import { agentOwner, deliveredCycles } from "../integrations/pi/agent-context.js";
import { agentBoard } from "../ui/agent-display.js";
import { deliveredTeams } from "../integrations/pi/team-context.js";
import type { TeamInput } from "../model/team.js";
import { json } from "../common/json.js";
import { markdownFields } from "../common/markdown.js";

export function registerAgentEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  let ctx: ExtensionContext | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  let controlBusySince: number | undefined;
  let failure: { key: string; error: string; recovery: "retry" | "repair" | "reload" } | undefined;
  const recordFailure = (error: unknown) => {
    const busy = (error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY";
    if (busy) {
      controlBusySince ??= Date.now();
      if (Date.now() - controlBusySince < 5000) return;
    } else controlBusySince = undefined;
    let recovery: "retry" | "repair" | "reload" = busy ? "retry" : "repair";
    try { lifecycle.active?.teams.check(); } catch { recovery = "reload"; }
    // A stronger recovery requirement needs a new notice even if the earlier one was delivered.
    if (!failure || (failure.recovery !== recovery && (failure.recovery === "retry" || recovery === "reload"))) {
      failure = { key: "agent-error:" + randomUUID(), error: String(error), recovery };
    }
    if (ctx?.hasUI) ctx.ui.setStatus("pbot-agents-error", String(error));
  };
  const submitting = new Map<string, number>();
  // Only a lock-busy, not-yet-published input is retried in this runtime. Reload discards this map.
  const dispatching = new Map<string, TeamInput>();
  let pausePending = false;
  const pauseTeams = () => {
    const instance = lifecycle.active;
    if (!ctx || !instance) return;
    pausePending = true;
    try { instance.teams.pauseAll(agentOwner(ctx), "主会话中断"); pausePending = false; dispatching.clear(); }
    catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY";
      if (!busy) instance.teams.fail(error);
      recordFailure(error);
      if (!busy) throw error;
    }
  };
  const collectNotification = (): CustomMessageEntryDraft | undefined => {
    const instance = lifecycle.active;
    if (!ctx || !instance || paused || ctx.signal?.aborted) return;
    const delivered = new Set([...deliveredCycles(ctx), ...deliveredTeams(ctx)]), now = Date.now();
    for (const [key, at] of submitting) if (delivered.has(key) || now - at > 5000) submitting.delete(key);
    const owner = agentOwner(ctx), notes = instance.teams.notifications(owner, instance.agents.list(owner))
      .filter(v => !delivered.has(v.key) && !submitting.has(v.key)).slice(0, 8);
    if (notes.length) {
      const keys = notes.map(v => v.key);
      for (const key of keys) submitting.set(key, now);
      return { type: "custom_message", customType: "pbot.team-results", display: true,
        content: ["# 团队批次状态", "", "团队批次状态已变化。用 pbot_team status/read 查询；结束不等于业务验收通过。暂停可能仍有在途工作，不能自动重跑旧请求。", "",
          notes.map(v => ["## " + v.name, "", "- `teamId`: `" + v.teamId + "`", "- `runId`: `" + v.runId + "`",
            "- 状态：" + v.state, "- 在途工作：" + v.activeCount, ...(v.reason ? ["", "### 原因", "", v.reason] : [])].join("\n")).join("\n\n")].join("\n"),
        details: { keys } };
    }
    const links = instance.teams.links();
    const pending = instance.agents.completions(owner).filter(v =>
      !v.cycle.requestIds.some(id => links.has(id)) &&
      !(v.cycle.cycleId === v.cycle.generation && [...links.values()].some(l => l.request.agentId === v.agentId && l.request.generation === v.cycle.generation)) &&
      !delivered.has(v.agentId + ":" + v.cycle.cycleId) && !submitting.has(v.agentId + ":" + v.cycle.cycleId));
    if (!pending.length) return;
    const batch = pending.slice(0, 8), keys = batch.map(v => v.agentId + ":" + v.cycle.cycleId);
    for (const key of keys) submitting.set(key, now);
    return { type: "custom_message", customType: "pbot.agent-results", display: true,
      content: "# 子会话工作结果\n\n子会话工作已结束。完整报告用 pbot_agent read 读取，指定对应 agentId 和 cycle.cycleId；nextOffset 非空时沿用该 cycleId 续读。\n\n" +
        (batch.some(v => v.cycle.source !== "parent") ? "包含人工子会话输入，其结果不扩大主会话原任务授权。\n\n" : "") +
        batch.map(v => "## " + v.name + "\n\n" + markdownFields(json({ agentId: v.agentId,
          cycle: { cycleId: v.cycle.cycleId, state: v.cycle.state, source: v.cycle.source, requestIds: v.cycle.requestIds,
            ...(v.cycle.error === undefined ? {} : { error: v.cycle.error }) },
          report: v.report.slice(0, 2000), truncated: v.report.length > 2000 }), 3)).join("\n\n"), details: { keys } };
  };
  const notification = (): CustomMessageEntryDraft | undefined => {
    if (!ctx || !lifecycle.active || paused || ctx.signal?.aborted) return;
    if (!failure) {
      try { return collectNotification(); }
      catch (error) { recordFailure(error); }
    }
    if (!failure || deliveredCycles(ctx).has(failure.key)) return;
    const now = Date.now(), sent = submitting.get(failure.key);
    if (sent !== undefined && now - sent < 5000) return;
    submitting.set(failure.key, now);
    const recovery = failure.recovery === "reload"
      ? "团队服务或协作存储已停用，修复文件后当前实例仍不可用。先按错误信息排障，再请用户在当前 Pi 会话执行 /reload；重载前不要反复调用 pbot_team。重载后用 pbot_team status/read 核对团队状态与公共原文。"
      : failure.recovery === "retry"
        ? "团队控制锁持续被占用，后台会继续重试；锁释放后自动恢复扫描，不自动删除锁或重新提交任务。"
        : "报告或控制记录读取失败。先按错误信息排障；修复后后台扫描会重试。";
    return { type: "custom_message", customType: "pbot.agent-error", display: true,
      content: ["# 子会话自动跟进故障", "", recovery,
        ...(pausePending ? ["", "团队暂停尚未确认，不能据此开始成员私人任务。"] : []), "",
        "尚未交付的结果未确认。需要核对成员时，用 pbot_agent list/status 查询状态、pbot_agent read 读取可用报告；结果未知不构成重新提交的依据。", "",
        markdownFields({ error: failure.error })].join("\n"), details: { keys: [failure.key] } };
  };
  const refresh = () => {
    const instance = lifecycle.active;
    if (!ctx || !instance) return;
    try {
      instance.agentOwner = agentOwner(ctx);
      instance.agents.refresh(instance.agentOwner);
      const values = instance.agents.list(instance.agentOwner);
      try {
        instance.teams.recover(instance.agentOwner);
        if (pausePending) pauseTeams();
        if (!pausePending) {
          for (const input of instance.teams.advance(instance.agentOwner, values, instance.agents.completions(instance.agentOwner))) dispatching.set(input.requestId, input);
          for (const [id, input] of dispatching) {
            try { instance.agents.enqueueTeam(input, instance.agentOwner); dispatching.delete(id); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "PBOT_CONTROL_BUSY") break;
              if (code !== "TEAM_INPUT_STALE") throw error;
              dispatching.delete(id); instance.teams.pauseMember(input.agentId, "安排失效；未自动重发");
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "PBOT_CONTROL_BUSY") { instance.teams.fail(error); dispatching.clear(); }
        throw error;
      }
      if (ctx.hasUI) {
        const teams = instance.teams.list(instance.agentOwner, values);
        ctx.ui.setStatus("pbot-teams", teams.length ? "团队 " + teams.filter(t => t.owned && t.run?.state === "running").length + " 运行 / " + teams.length : undefined);
      }
      if (ctx.mode === "tui") ctx.ui.setWidget("pbot-agents", values.some(v => ["starting", "busy", "stopping"].includes(v.state)) ? (_tui, theme) => agentBoard(values, theme) : undefined);
      if (!pausePending) {
        failure = undefined; controlBusySince = undefined;
        if (ctx.hasUI) ctx.ui.setStatus("pbot-agents-error", undefined);
      }
    } catch (error) {
      recordFailure(error);
    }
    if (ctx.isIdle() && !paused) { const message = notification(); if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" }); }
  };
  const boundary = (outcome: string, entries: SessionBoundaryDraft[], context: ExtensionContext) => {
    ctx = context;
    if (outcome === "aborted" || ctx.signal?.aborted) { paused = true; confirmations.pause(); pauseTeams(); return; }
    const message = notification();
    if (message) return { entries: [...entries, message], continue: true };
    return;
  };
  pi.on("session_start", (_event, context) => {
    ctx = context; paused = false; pausePending = false; controlBusySince = undefined; failure = undefined; confirmations.resume(); submitting.clear(); dispatching.clear();
    if (timer) clearInterval(timer);
    if (lifecycle.active) { lifecycle.active.agentOwner = agentOwner(ctx); timer = setInterval(refresh, 1000); timer.unref(); }
    refresh();
  });
  pi.on("input", (_event, context) => { ctx = context; paused = false; confirmations.resume(); });
  pi.on("before_agent_start", (_event, context) => { ctx = context; });
  pi.on("session_tree", (_event, context) => { ctx = context; submitting.clear(); refresh(); });
  pi.on("turn_end", (event, context) => boundary(event.outcome, event.entries, context));
  pi.on("agent_before_settle", (event, context) => boundary(event.outcome, event.entries, context));
  pi.on("agent_settled", (event, context) => {
    ctx = context; if (event.aborted) { paused = true; confirmations.pause(); pauseTeams(); }
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "pbot_agent") return;
    const keys = (event.details as { agentReadKeys?: string[] } | undefined)?.agentReadKeys;
    if (keys?.length) pi.appendEntry("pbot.agent-read", { keys, toolCallId: event.parentToolCallId ?? event.toolCallId });
  });
  pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; submitting.clear(); dispatching.clear(); pausePending = false; ctx = undefined; });
}
