import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { historyLocation, historySummarizer } from "../integrations/pi/history.js";
import type { Lifecycle, WorkspaceInstance } from "./lifecycle.js";

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

const label = (node: { kind: string; from: string; ready: boolean; preview: string }) =>
  `${node.from.slice(0, 16)} · ${node.kind === "session" ? "会话" : node.kind === "summary" ? "摘要" : "问答"}${node.ready ? "" : "（待整理）"} · ${node.preview}`;

export async function showHistory(instance: WorkspaceInstance, ctx: ExtensionCommandContext, query: string) {
  await instance.history.refresh(historyLocation(ctx), instance.signal(ctx.signal));
  const service = instance.history;
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify(service.search({ query })), "info"); return; }
  for (const warning of service.warnings) ctx.ui.notify(warning, "warning");
  let offset = 0;
  for (;;) {
    instance.check();
    const result = service.search({ query, offset });
    const choices = result.matches.map((node, index) => `${index + 1}. ${label(node)} · ${node.snippet.replace(/\s+/g, " ").slice(0, 80)}`);
    const more = "下一页", search = "重新搜索", back = "返回";
    const selected = await ctx.ui.select(`历史：${query || "最近会话"}（${result.total}）`, [...choices, ...(result.nextOffset === null ? [] : [more]), search, back]);
    if (!selected || selected === back) return;
    if (selected === more) { offset = result.nextOffset!; continue; }
    if (selected === search) {
      const value = await ctx.ui.input("全文搜索（留空列出会话）", query);
      if (value !== undefined) { query = value; offset = 0; }
      continue;
    }
    let id = result.matches[choices.indexOf(selected)]!.id, textOffset = 0, childrenOffset = 0;
    for (;;) {
      instance.check();
      const node = service.read(id, textOffset, 12000, childrenOffset);
      const body = "查看正文", nextText = "后续正文", nextChildren = "后续子节点", first = "回到本节点开头";
      const links = [...node.parents.map(parent => ({ ...parent, direction: "↑" })), ...node.children.map(child => ({ ...child, direction: "↓" }))];
      const names = links.map((value, index) => `${index + 1}. ${value.direction} ${label(value)}`);
      const action = await ctx.ui.select(label(node), [body, ...names, ...(node.nextOffset === null ? [] : [nextText]),
        ...(node.nextChildrenOffset === null ? [] : [nextChildren]), ...(textOffset || childrenOffset ? [first] : []), back]);
      if (!action || action === back) break;
      if (action === body || action === nextText) {
        if (action === nextText) textOffset = node.nextOffset!;
        const page = service.read(id, textOffset, 12000, childrenOffset);
        await ctx.ui.editor(`历史正文 ${textOffset}/${page.totalLength}（修改不保存）`, page.text || "摘要尚未生成，可以展开下层节点。");
        continue;
      }
      if (action === nextChildren) { childrenOffset = node.nextChildrenOffset!; continue; }
      if (action === first) { textOffset = 0; childrenOffset = 0; continue; }
      id = links[names.indexOf(action)]!.id; textOffset = 0; childrenOffset = 0;
    }
  }
}
