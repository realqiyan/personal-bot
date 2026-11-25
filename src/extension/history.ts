import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { historyLocation, historySummarizer } from "../integrations/pi/history.js";
import type { Lifecycle } from "./lifecycle.js";

export function registerHistoryEvents(pi: ExtensionAPI, lifecycle: Lifecycle) {
  pi.on("session_start", async (_event, ctx) => {
    const instance = lifecycle.active;
    if (!instance) return;
    try { await instance.history.refresh(historyLocation(ctx), instance.signal()); }
    catch (error) { ctx.ui.notify("历史索引：" + String(error), "warning"); }
  });
  pi.on("agent_settled", (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance || event.aborted) return;
    const signal = instance.signal();
    void (async () => {
      await instance.history.refresh(historyLocation(ctx), signal);
      signal.throwIfAborted();
      const summarize = await historySummarizer(ctx);
      ctx.ui.setStatus("pbot-history", "历史整理中");
      await instance.history.organize(summarize, signal);
    })().catch(error => {
      if (!signal.aborted) ctx.ui.notify("历史摘要暂未完成，下次交互结束后重试：" + String(error), "warning");
    }).finally(() => { if (lifecycle.active === instance) ctx.ui.setStatus("pbot-history", undefined); });
  });
}
