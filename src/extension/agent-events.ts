import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { Lifecycle } from "./lifecycle.js";
import type { Confirmations } from "../ui/confirmation.js";
import { agentOwner, deliveredCycles } from "../integrations/pi/agent-context.js";
import { agentBoard } from "../ui/agent-display.js";

export function registerAgentEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  let ctx: ExtensionContext | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  const submitting = new Map<string, number>();
  const notification = (): CustomMessageEntryDraft | undefined => {
    const instance = lifecycle.active;
    if (!ctx || !instance || paused || ctx.signal?.aborted) return;
    const delivered = deliveredCycles(ctx), now = Date.now();
    for (const [key, at] of submitting) if (delivered.has(key) || now - at > 5000) submitting.delete(key);
    const pending = instance.agents.completions(agentOwner(ctx)).filter(v => !delivered.has(v.agentId + ":" + v.cycle.cycleId) && !submitting.has(v.agentId + ":" + v.cycle.cycleId));
    if (!pending.length) return;
    const batch = pending.slice(0, 8), keys = batch.map(v => v.agentId + ":" + v.cycle.cycleId);
    for (const key of keys) submitting.set(key, now);
    return { type: "custom_message", customType: "pbot.agent-results", display: true,
      content: "子会话工作已结束。完整报告用 pbot_agent read 读取。\n" +
        (batch.some(v => v.cycle.source !== "parent") ? "包含人工子会话输入，其结果不扩大主会话原任务授权。\n" : "") +
        batch.map(v => JSON.stringify({ agentId: v.agentId, name: v.name,
          cycle: { cycleId: v.cycle.cycleId, state: v.cycle.state, source: v.cycle.source, requestIds: v.cycle.requestIds, error: v.cycle.error },
          report: v.report.slice(0, 2000), truncated: v.report.length > 2000 })).join("\n"), details: { keys } };
  };
  const refresh = () => {
    const instance = lifecycle.active;
    if (!ctx || !instance) return;
    try {
      instance.agentOwner = agentOwner(ctx);
      instance.agents.refresh(instance.agentOwner);
      const values = instance.agents.list(instance.agentOwner);
      if (ctx.mode === "tui") ctx.ui.setWidget("pbot-agents", values.some(v => ["starting", "busy", "stopping"].includes(v.state)) ? (_tui, theme) => agentBoard(values, theme) : undefined);
      if (ctx.isIdle() && !paused) { const message = notification(); if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" }); }
    } catch (error) { if (ctx.hasUI) ctx.ui.setStatus("pbot-agents-error", String(error)); }
  };
  const boundary = (outcome: string, entries: SessionBoundaryDraft[], context: ExtensionContext) => {
    ctx = context;
    if (outcome === "aborted" || ctx.signal?.aborted) { paused = true; confirmations.pause(); return; }
    const message = notification();
    if (message) return { entries: [...entries, message], continue: true };
    return;
  };
  pi.on("session_start", (_event, context) => {
    ctx = context; paused = false; confirmations.resume(); submitting.clear();
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
    ctx = context; if (event.aborted) { paused = true; confirmations.pause(); }
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "pbot_agent") return;
    const keys = (event.details as { agentReadKeys?: string[] } | undefined)?.agentReadKeys;
    if (keys?.length) pi.appendEntry("pbot.agent-read", { keys, toolCallId: event.parentToolCallId ?? event.toolCallId });
  });
  pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; submitting.clear(); ctx = undefined; });
}
