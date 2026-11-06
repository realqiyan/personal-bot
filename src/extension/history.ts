import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { historyLocation, historySummarizer } from "../integrations/pi/history.js";
import type { Lifecycle, WorkspaceInstance } from "./lifecycle.js";
import { readPage } from "../ui/pi/reader.js";
import { choose } from "../ui/pi/menu.js";

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

const label = (node: { host: string; kind: string; from: string; ready: boolean; preview: string }) =>
  `${node.host} · ${node.from.slice(0, 10)} · ${node.kind === "session" ? "会话" : node.kind === "summary" ? "摘要" : "问答"}${node.ready ? "" : "（待整理）"} · ${node.preview.replace(/\s+/g, " ").slice(0, 48)}`;

export async function showHistory(instance: WorkspaceInstance, ctx: ExtensionCommandContext, query: string) {
  await instance.history.refresh(historyLocation(ctx), instance.signal(ctx.signal));
  const service = instance.history;
  if (ctx.mode !== "tui") { ctx.ui.notify(JSON.stringify(service.search({ query })), "info"); return; }
  for (const warning of service.warnings) ctx.ui.notify(warning, "warning");
  let offset = 0;
  for (;;) {
    instance.check();
    const result = service.search({ query, offset });
    const choices = result.matches.map((node, index) => `${index + 1}. ${label(node)}`);
    const more = "下一页", previous = "上一页", search = "搜索", back = "返回";
    const selected = await choose(ctx, `历史 · ${query || "最近会话"} · ${result.total} 项`, [...choices, ...(offset ? [previous] : []), ...(result.nextOffset === null ? [] : [more]), search, back]);
    if (!selected || selected === back) return;
    if (selected === more) { offset = result.nextOffset!; continue; }
    if (selected === previous) { offset = Math.max(0, offset - 20); continue; }
    if (selected === search) {
      const value = await ctx.ui.input("全文搜索（留空列出会话）", query);
      if (value !== undefined) { query = value; offset = 0; }
      continue;
    }
    let current = result.matches[choices.indexOf(selected)]!, id = current.id, source = current.host, textOffset = 0, childrenOffset = 0;
    for (;;) {
      instance.check();
      const node = service.read(id, textOffset, 12000, childrenOffset, source);
      const body = "正文", nextText = "后续正文", nextChildren = "更多下级", first = "回到开头";
      const links = [...node.parents.map(parent => ({ ...parent, direction: "↑" })), ...node.children.map(child => ({ ...child, direction: "↓" }))];
      const names = links.map((value, index) => `${index + 1}. ${value.direction} ${label(value)}`);
      const action = await choose(ctx, label(node), [body, ...names, ...(node.nextOffset === null ? [] : [nextText]),
        ...(node.nextChildrenOffset === null ? [] : [nextChildren]), ...(textOffset || childrenOffset ? [first] : []), back]);
      if (!action || action === back) break;
      if (action === body || action === nextText) {
        if (action === nextText) textOffset = node.nextOffset!;
        const page = service.read(id, textOffset, 12000, childrenOffset, source);
        await readPage(ctx, `历史正文 · ${textOffset + 1}–${textOffset + page.text.length}/${page.totalLength}`, page.text || "摘要待整理，请展开下级记录。");
        continue;
      }
      if (action === nextChildren) { childrenOffset = node.nextChildrenOffset!; continue; }
      if (action === first) { textOffset = 0; childrenOffset = 0; continue; }
      const link = links[names.indexOf(action)]!; id = link.id; source = link.host; textOffset = 0; childrenOffset = 0;
    }
  }
}
