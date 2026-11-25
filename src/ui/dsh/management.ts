import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { object, json } from "../../common/json.js";
import { block, details, element, empty, facts, field, group, note, pageTitle, record, rows, select, text, time } from "./elements.js";
import { managementStyles } from "./styles.js";
import type {} from "./remote.js";

/** The view owns workspace and history queries. Accepted commands belong to the server workspace. */
export function showManagement(ctx: Context, parentSessionId: SessionId) {
  const opener = document.activeElement, dialog = element("dialog"), style = element("style");
  dialog.className = "pbot-management"; dialog.setAttribute("aria-label", "Personal Bot 工作台"); style.textContent = managementStyles;
  const shell = group(dialog, "pbot-shell"), header = element("header", "", "pbot-header"); shell.append(header);
  const heading = group(header, "pbot-header-copy"); heading.append(element("div", "Personal Bot", "pbot-brand"));
  const location = element("p", "正在读取工作区…", "pbot-location"); heading.append(location);
  const nav = element("nav", "", "pbot-nav"), main = element("main", "", "pbot-main"), footer = element("footer", "", "pbot-footer");
  nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "工作台导航");
  const notice = element("div", "", "pbot-notice"), connection = element("span", "正在连接…"); notice.setAttribute("role", "status");
  main.append(notice); footer.append(connection); shell.append(nav, main, footer); dialog.prepend(style);
  const lifetime = new AbortController(); let closed = false, timer: number | undefined, tab = "status";
  let snapshot: Record<string, unknown> | undefined;
  let snapshotRevision = 0, historyRevision = 0, pollError = false;
  const sections = new Map<string, HTMLElement>(), tabs = new Map<string, HTMLButtonElement>();

  function inform(message: string, tone = "info") {
    if (closed) return; notice.textContent = message; notice.dataset.tone = tone;
    notice.setAttribute("role", tone === "error" ? "alert" : "status");
  }
  function enabled(button: HTMLButtonElement, value: boolean) {
    button.dataset.unavailable = String(!value); button.disabled = !value || button.dataset.busy === "true";
  }
  async function attempt(button: HTMLButtonElement, action: () => void | Promise<void>) {
    if (button.dataset.busy === "true") return;
    button.dataset.busy = "true"; button.disabled = true; button.setAttribute("aria-busy", "true");
    try { await action(); } catch (error) { if (!lifetime.signal.aborted) inform(error instanceof Error ? error.message : String(error), "error"); }
    finally { if (!closed) { delete button.dataset.busy; button.removeAttribute("aria-busy"); button.disabled = button.dataset.unavailable === "true"; } }
  }
  function button(parent: HTMLElement, title: string, action: () => void | Promise<void>, className = "") {
    const node = element("button", title, className); node.type = "button";
    node.addEventListener("click", () => { void attempt(node, action); }); parent.append(node); return node;
  }
  function submit(form: HTMLFormElement, title: string, action: () => void | Promise<void>) {
    const node = element("button", title, "pbot-primary"); node.type = "submit"; form.append(node);
    form.addEventListener("submit", event => { event.preventDefault(); void attempt(node, action); }); return node;
  }
  function form(parent: HTMLElement) { const node = element("form"); parent.append(node); return node; }
  function activate(id: string) {
    if (snapshot?.enabled === false && id !== "status") return;
    tab = id;
    for (const [key, section] of sections) section.hidden = key !== id;
    for (const [key, item] of tabs) { item.setAttribute("aria-selected", String(key === id)); item.tabIndex = key === id ? 0 : -1; }
    main.scrollTop = 0;
  }
  function section(id: string, title: string) {
    const node = element("section"); node.hidden = id !== tab; node.id = `pbot-panel-${id}`;
    node.setAttribute("role", "tabpanel"); node.setAttribute("aria-labelledby", `pbot-tab-${id}`); main.append(node); sections.set(id, node);
    const control = button(nav, title, () => activate(id)); control.id = `pbot-tab-${id}`; control.setAttribute("role", "tab");
    control.setAttribute("aria-controls", node.id); control.setAttribute("aria-selected", String(id === tab)); control.tabIndex = id === tab ? 0 : -1;
    tabs.set(id, control); return node;
  }
  nav.addEventListener("keydown", event => {
    const controls = [...tabs.values()], current = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
      : ["ArrowRight", "ArrowDown"].includes(event.key) ? (current + 1) % controls.length
      : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (current + controls.length - 1) % controls.length : -1;
    if (index < 0) return; event.preventDefault(); const id = [...tabs.keys()][index]!; activate(id); controls[index]!.focus();
  });
  async function query(method: "snapshot" | "history", input?: unknown) {
    lifetime.signal.throwIfAborted();
    const result = await ctx.remote.pbot[method](json({ parentSessionId, ...(input === undefined ? {} : { input }) }), lifetime.signal);
    if (!result.ok) throw new Error(result.error.message);
    lifetime.signal.throwIfAborted(); return record(result.value);
  }
  async function command(verb: string, input?: unknown, message = "操作已接纳。") {
    const result = await ctx.remote.commands.execute(parentSessionId, "/pbot " + verb + (input === undefined ? "" : " " + JSON.stringify(input)), []);
    if (!result.ok) throw new Error(result.error.message + "；如连接中断，请先刷新记录确认操作是否已接纳。");
    if (!result.value) throw new Error("管理命令未被接纳。");
    if (result.value.result.kind === "error") throw new Error(result.value.result.text);
    inform(message);
    if (!closed) { try { await refresh(); } catch (error) { inform("操作已接纳；刷新状态未成功：" + String(error), "error"); } }
    return result.value.result.text ?? "";
  }

  const status = section("status", "工作区"); pageTitle(status, "工作区", "");
  const counts = note(""), workspaceInfo = group(status); status.querySelector("header")!.after(counts); counts.classList.add("pbot-counts");
  const materials = group(status, "pbot-setting"); materials.append(element("h3", "资料目录"));
  const initializeButton = button(materials, "准备目录", async () => { await command("init", undefined, "工作区已初始化并启用。"); });
  const diagnostic = details(status, "环境详情"), statusBody = block(""); statusBody.classList.add("pbot-raw"); diagnostic.append(statusBody);

  const history = section("history", "历史"); pageTitle(history, "历史", "");
  const searchForm = form(history); searchForm.className = "pbot-search";
  const historyQuery = field(searchForm, "关键词"), host = select(searchForm, "来源", [["", "全部"], ["pi", "Pi"], ["dsh", "dsh"], ["claude", "Claude Code"]]);
  historyQuery.placeholder = "留空查看最近会话"; submit(searchForm, "查询", () => searchHistory());
  const dateFilters = details(history, "时间范围"), dateGrid = group(dateFilters, "pbot-grid");
  const historyFrom = field(dateGrid, "开始时间"), historyTo = field(dateGrid, "结束时间");
  for (const input of [historyFrom, historyTo]) (input as HTMLInputElement).type = "datetime-local";
  const historyBody = group(history, "pbot-history-results"), historyPaging = group(history, "pbot-pagination"), historyNode = group(history, "pbot-card"); historyNode.hidden = true;
  historyBody.append(empty("查询历史", "输入关键词，或留空查看最近会话。"));
  let historySearch: Record<string, unknown> = {};
  function warnings(parent: HTMLElement, values: unknown) {
    if (Array.isArray(values)) for (const warning of values) if (warning) parent.append(element("p", text(warning), "pbot-warning"));
  }
  async function searchHistory(offset = 0, keepFilters = false) {
    if (!keepFilters) historySearch = {
      query: historyQuery.value,
      ...(host.value ? { host: host.value } : {}),
      ...(historyFrom.value ? { from: new Date(historyFrom.value).toISOString() } : {}),
      ...(historyTo.value ? { to: new Date(historyTo.value).toISOString() } : {}),
    };
    const revision = ++historyRevision, data = await query("history", { action: "search", ...historySearch, offset });
    if (revision !== historyRevision) return;
    historyNode.hidden = true; historyBody.replaceChildren(note(`共 ${data.total} 项`)); warnings(historyBody, data.warnings); historyPaging.replaceChildren();
    for (const match of rows(data.matches)) {
      const item = element("article"), meta = group(item, "pbot-between"); item.dataset.id = text(match.id); item.dataset.host = text(match.host);
      meta.append(element("h4", text(match.name)), element("span", text(match.host), "pbot-badge"));
      item.append(note(`${time(match.from)} · ${match.kind === "session" ? "会话" : match.kind === "summary" ? "摘要" : "问答"}`), block(match.snippet || match.preview));
      button(item, "读取", () => readHistory(text(match.id), text(match.host)), "pbot-quiet"); historyBody.append(item);
    }
    if (!rows(data.matches).length) historyBody.append(empty("没有找到匹配内容", "试试更短的关键词，或调整来源和时间范围。"));
    if (offset) button(historyPaging, "上一页", () => searchHistory(Math.max(0, offset - 20), true));
    if (typeof data.nextOffset === "number") button(historyPaging, "下一页", () => searchHistory(data.nextOffset as number, true));
  }
  async function readHistory(id: string, source: string, offset = 0, childrenOffset = 0) {
    const revision = ++historyRevision, data = await query("history", { action: "read", id, host: source, offset, childrenOffset });
    if (revision !== historyRevision) return;
    const node = record(data.node); historyNode.hidden = false;
    historyNode.replaceChildren(
      element("h3", text(node.name)),
      note(`${text(node.host)} · ${time(node.from)} · ${node.completed ? "原交互已完成" : "原交互未确认完成"}`),
      block(node.text || "摘要尚未生成，可展开下级记录阅读原文。"),
    );
    warnings(historyNode, data.warnings);
    for (const item of historyBody.querySelectorAll<HTMLElement>("article")) item.setAttribute("aria-current", String(item.dataset.id === id && item.dataset.host === source));
    const paging = group(historyNode, "pbot-pagination");
    if (offset) button(paging, "正文开头", () => readHistory(id, source, 0, childrenOffset));
    if (typeof node.nextOffset === "number") button(paging, "继续正文", () => readHistory(id, source, node.nextOffset as number, childrenOffset));
    for (const [label, values] of [["上级摘要", node.parents], ["下级记录", node.children]] as const) {
      if (!rows(values).length) continue;
      const related = group(historyNode, "pbot-stack"); related.append(element("h4", label));
      for (const item of rows(values)) button(related, text(item.preview || item.name), () => readHistory(text(item.id), text(item.host)), "pbot-quiet");
    }
    if (childrenOffset) button(paging, "首批下级", () => readHistory(id, source, offset));
    if (typeof node.nextChildrenOffset === "number") button(paging, "更多下级", () => readHistory(id, source, offset, node.nextChildrenOffset as number));
    const provenance = block(node.source); provenance.classList.add("pbot-raw"); details(historyNode, "原始来源位置").append(provenance);
    historyNode.scrollIntoView({ block: "start" });
  }

  function renderSnapshot() {
    if (!snapshot) return;
    location.textContent = text(snapshot.workspaceRoot).split(/[\\/]/).filter(Boolean).at(-1) ?? ""; location.title = text(snapshot.workspaceRoot);
    if (snapshot.enabled === false) {
      const configuration = record(snapshot.configuration);
      counts.textContent = configuration.error ? "Personal Bot 配置错误" : "Personal Bot 未启用";
      workspaceInfo.replaceChildren(
        facts([["状态", configuration.error ? "配置错误" : "未启用"], ["工作区", snapshot.workspaceRoot], ["配置文件", configuration.path]]),
        note(configuration.error ? "修复配置文件后执行 /pbot init。" : "执行 /pbot init，或点击下方按钮初始化并启用。"),
      );
      materials.hidden = false; initializeButton.textContent = "初始化并启用";
      enabled(initializeButton, !configuration.error);
      for (const [id, control] of tabs) enabled(control, id === "status");
      activate("status");
      statusBody.textContent = JSON.stringify(snapshot, null, 2);
      if (configuration.error) inform(text(configuration.error), "error");
      return;
    }
    for (const control of tabs.values()) enabled(control, true);
    materials.hidden = false; initializeButton.textContent = "准备目录"; enabled(initializeButton, true);
    const historyState = record(snapshot.history);
    counts.textContent = "Personal Bot 已启动 · 跨 Harness 调度通过 MCP pbot_worker 提供";
    const model = object(snapshot.model) ? snapshot.model : {};
    workspaceInfo.replaceChildren(facts([
      ["状态", "已启动"],
      ["工作区", snapshot.workspaceRoot],
      ["配置文件", record(snapshot.configuration).path],
      ["模型", model.model || "尚未选择"],
      ["Provider", model.provider || "—"],
      ["历史", historyState.organizing ? "整理中" : historyState.pending === null ? "查询时更新索引" : `${historyState.pending} 项待整理`],
    ]));
    statusBody.textContent = JSON.stringify(snapshot, null, 2);
  }

  async function refresh() {
    const revision = ++snapshotRevision, value = await query("snapshot"); if (revision !== snapshotRevision) return;
    snapshot = value; renderSnapshot(); connection.textContent = "已连接 · 状态自动更新";
  }

  button(footer, "刷新状态", refresh, "pbot-quiet");
  const close = button(header, "×", () => dispose(), "pbot-close pbot-quiet"); close.setAttribute("aria-label", "关闭工作台"); close.title = "关闭 · Esc";
  const dispose = ctx.effect(() => {
    document.body.append(dialog); dialog.showModal(); tabs.get("status")!.focus();
    return () => { closed = true; lifetime.abort(); if (timer !== undefined) window.clearTimeout(timer); dialog.close(); dialog.remove(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); void dispose(); });
  async function poll() {
    try {
      await refresh();
      if (pollError) { inform("连接已恢复，状态已更新。"); pollError = false; }
    } catch (error) {
      if (!closed) { connection.textContent = "连接中断 · 正在重试"; if (!pollError) inform("读取状态失败：" + String(error), "error"); pollError = true; }
    } finally { if (!closed) timer = window.setTimeout(() => { void poll(); }, 2000); }
  }
  void poll();
}
