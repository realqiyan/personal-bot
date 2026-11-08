import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { CommandSubmitAttachment } from "@deepseek-ai/dsh-commands/types";
import { commandAttachments } from "./attachments.js";
import { object, json } from "../../common/json.js";
import { stateLabel } from "../presentation.js";
import { badge, block, details, element, empty, facts, field, group, lines, note, objectInput, pageTitle, record, rows, select, text, time } from "./elements.js";
import { managementStyles } from "./styles.js";
import type {} from "./remote.js";

/** The view owns drafts, uploads and queries. Accepted commands belong to the server workspace. */
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
  let snapshot: Record<string, unknown> | undefined, expertId = "", teamId = "", expertOffset: number | undefined;
  let snapshotRevision = 0, expertRevision = 0, teamRevision = 0, historyRevision = 0, recordRevision = 0;
  let expertPageKey = "", teamPageKey = "", pollError = false;
  const sections = new Map<string, HTMLElement>(), tabs = new Map<string, HTMLButtonElement>(), tabCounts = new Map<string, HTMLElement>();
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
    const count = element("small"); count.setAttribute("aria-hidden", "true"); control.append(count); tabCounts.set(id, count); tabs.set(id, control); return node;
  }
  nav.addEventListener("keydown", event => {
    const controls = [...tabs.values()], current = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
      : ["ArrowRight", "ArrowDown"].includes(event.key) ? (current + 1) % controls.length
      : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (current + controls.length - 1) % controls.length : -1;
    if (index < 0) return; event.preventDefault(); const id = [...tabs.keys()][index]!; activate(id); controls[index]!.focus();
  });
  async function query(method: "snapshot" | "expert" | "team" | "history", input?: unknown) {
    lifetime.signal.throwIfAborted();
    const result = await ctx.remote.pbot[method](json({ parentSessionId, ...(input === undefined ? {} : { input }) }), lifetime.signal);
    if (!result.ok) throw new Error(result.error.message);
    lifetime.signal.throwIfAborted(); return record(result.value);
  }
  async function command(verb: string, input?: unknown, message = "操作已接纳。", attachments: readonly CommandSubmitAttachment[] = []) {
    // Closing the view must not cancel an admitted command.
    const result = await ctx.remote.commands.execute(parentSessionId, "/pbot " + verb + (input === undefined ? "" : " " + JSON.stringify(input)), attachments);
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
  const pythonCard = group(status, "pbot-setting"), pythonInfo = group(pythonCard);
  const pythonButton = button(pythonCard, "准备 Python", async () => { await command("python setup", undefined, "Python 准备完成。"); });
  const diagnostic = details(status, "环境详情"), statusBody = block(""); statusBody.classList.add("pbot-raw"); diagnostic.append(statusBody);

  const experts = section("experts", "专家"); pageTitle(experts, "专家", "");
  const create = details(experts, "创建专家"), createForm = form(create), newName = field(createForm, "名称"), initial = field(createForm, "任务（可选）", true);
  newName.placeholder = "例如：研究员"; initial.placeholder = "任务目标与交付要求";
  const options = details(createForm, "模型与选项"), modelFields = group(options, "pbot-grid");
  options.querySelector("summary")!.after(note("留空沿用当前会话。"));
  const provider = field(modelFields, "Provider"), model = field(modelFields, "模型");
  const effort = field(options, "Reasoning effort"), cwd = field(options, "工作目录");
  const files = field(options, "文件路径（每行一个）", true);
  const advanced = field(details(options, "其他选项"), "JSON", true, "{}");
  submit(createForm, "创建", async () => {
    const args = { ...objectInput(advanced.value), action: "start", ...(newName.value ? { name: newName.value } : {}),
      ...(initial.value ? { message: initial.value } : {}), ...(provider.value ? { provider: provider.value } : {}),
      ...(model.value ? { model: model.value } : {}), ...(effort.value ? { thinking: effort.value } : {}),
      ...(cwd.value ? { cwd: cwd.value } : {}), ...(lines(files.value).length ? { files: lines(files.value) } : {}) };
    const output = objectInput(await command("agent", args, "专家已创建。"));
    if (initial.value === (args.message ?? "")) initial.value = ""; create.open = false; await chooseExpert(text(output.agentId));
  });
  const expertSplit = group(experts, "pbot-split"), expertAside = group(expertSplit), expertFilter = field(expertAside, "筛选专家");
  expertFilter.placeholder = "名称或状态"; const expertList = group(expertAside, "pbot-list");
  expertList.setAttribute("aria-label", "专家列表");
  const expertDetail = group(expertSplit, "pbot-detail"), expertEmpty = empty("选择专家", "查看记录或发送消息。"); expertDetail.append(expertEmpty);
  const expertPanel = group(expertDetail); expertPanel.hidden = true;
  const expertHeading = group(expertPanel, "pbot-detail-title"), expertTitle = element("h3"), expertBadge = element("span"); expertHeading.append(expertTitle, expertBadge);
  const expertInfo = group(expertPanel), expertError = element("p", "", "pbot-warning"); expertPanel.append(expertError); expertError.hidden = true;
  const expertControls = group(expertPanel, "pbot-row"), requireExpert = () => { if (!expertId) throw new Error("请先选择专家。"); return expertId; };
  const stopButton = button(expertControls, "停止专家", async () => { await command("agent", { action: "stop", agentId: requireExpert() }, "已请求停止专家。"); await loadExpert(); }, "pbot-danger");
  const editExpert = details(expertPanel, "名称与会话详情"), renameForm = form(editExpert), rename = field(renameForm, "新名称"); rename.required = true;
  submit(renameForm, "重命名", async () => { await command("agent", { action: "rename", agentId: requireExpert(), name: rename.value }, "专家名称已更新。"); await loadExpert(); });
  const expertState = block(""); expertState.classList.add("pbot-raw"); editExpert.append(expertState);
  const resume = details(expertPanel, "恢复专家"), resumeForm = form(resume), resumeText = field(resumeForm, "新任务", true); resumeText.required = true;
  const resumeButton = submit(resumeForm, "恢复并发送新任务", async () => {
    const message = resumeText.value; await command("agent", { action: "resume", agentId: requireExpert(), message }, "专家已恢复，新任务已排队。");
    if (resumeText.value === message) resumeText.value = ""; await loadExpert();
  });
  const chatCard = group(expertPanel, "pbot-card"); chatCard.append(element("h3", "人工对话"), note("发送前暂停团队新安排。"));
  const chatForm = form(chatCard), chat = field(chatForm, "消息", true); chat.maxLength = 24000; chat.placeholder = "补充资料、调整方向，或提出新问题…";
  const delivery = select(chatForm, "投递时机", [["steer", "下一个安全步骤"], ["followUp", "下一轮"]]);
  const localFiles = field(chatForm, "附件") as HTMLInputElement; localFiles.type = "file"; localFiles.multiple = true;
  const chatFiles = field(details(chatForm, "服务器文件"), "路径（每行一个）", true);
  const expertDrafts = new Map<string, { text: string; delivery: string; paths: string; files: File[] }>();
  function clearSentDraft(id: string, input: { text: string }, paths: string, chosen: File[]) {
    const draft = expertDrafts.get(id);
    if (draft) {
      if (draft.text === input.text) draft.text = ""; if (draft.paths === paths) draft.paths = "";
      if (draft.files.length === chosen.length && draft.files.every((file, index) => file === chosen[index])) draft.files = [];
    }
  }
  const sendButton = submit(chatForm, "发送人工消息", async () => {
    const id = requireExpert(), fileText = chatFiles.value, files = lines(fileText), chosen = Array.from(localFiles.files ?? []);
    if (files.length && chosen.length) throw new Error("一次对话请选择服务器文件或本机附件，不能同时使用。");
    if (!chat.value.trim() && !files.length && !chosen.length) { chat.focus(); throw new Error("请输入消息或添加附件。"); }
    const input = { agentId: id, text: chat.value, delivery: delivery.value, files };
    const attachments = await commandAttachments(ctx, parentSessionId, chosen, lifetime.signal, inform);
    lifetime.signal.throwIfAborted(); await command("chat", input, "消息已排队，专家会在所选时机接收。", attachments);
    clearSentDraft(id, input, fileText, chosen);
    if (expertId === id) {
      if (chat.value === input.text) chat.value = ""; if (chatFiles.value === fileText) chatFiles.value = "";
      const current = Array.from(localFiles.files ?? []);
      if (current.length === chosen.length && current.every((file, index) => file === chosen[index])) localFiles.value = "";
      await loadExpert();
    }
  });
  const transcript = group(expertPanel, "pbot-transcript"); transcript.append(element("h3", "对话与活动"));
  const recordControls = group(transcript, "pbot-pagination"), eventList = group(transcript), rawEvents = details(transcript, "全部原生事件"), rawEventList = group(rawEvents);
  const eventDetail = details(transcript, "完整记录"), eventBody = block(""), eventPaging = element("div", "", "pbot-pagination"); eventDetail.append(eventBody, eventPaging); eventDetail.hidden = true;
  async function chooseExpert(id: string) {
    if (id !== expertId) {
      if (expertId) expertDrafts.set(expertId, { text: chat.value, delivery: delivery.value, paths: chatFiles.value, files: Array.from(localFiles.files ?? []) });
      const draft = expertDrafts.get(id); chat.value = draft?.text ?? ""; delivery.value = draft?.delivery ?? "steer"; chatFiles.value = draft?.paths ?? "";
      const transfer = new DataTransfer(); for (const file of draft?.files ?? []) transfer.items.add(file); localFiles.files = transfer.files;
      rename.value = ""; resumeText.value = "";
    }
    expertId = id; expertOffset = undefined; expertPageKey = ""; ++recordRevision; ++expertRevision;
    eventBody.textContent = ""; eventDetail.hidden = true; eventPaging.replaceChildren(); expertPanel.hidden = true;
    expertEmpty.hidden = false; expertEmpty.replaceChildren(note("正在读取专家记录…"));
    renderLists(); await loadExpert();
  }
  function showExpert(agent: Record<string, unknown>) {
    expertTitle.textContent = text(agent.name); expertBadge.replaceChildren(badge(agent.state)); expertPanel.hidden = false; expertEmpty.hidden = true;
    const config = object(agent.options) ? agent.options : {};
    expertInfo.replaceChildren(note(text(agent.activity) || "等待新的任务。"), facts([["模型", config.model || "继承父会话"], ["工作目录", agent.cwd]]));
    expertState.textContent = JSON.stringify(agent, null, 2); expertError.textContent = text(agent.error); expertError.hidden = !agent.error;
    const alive = agent.alive === true, owned = agent.owned === true;
    enabled(stopButton, owned && alive && agent.state !== "stopping"); enabled(sendButton, owned && alive && !["starting", "stopping"].includes(text(agent.state)));
    enabled(resumeButton, owned && !alive); resume.hidden = alive;
  }
  async function loadRecord(seq: number, offset = 0, format: "text" | "json" = "text") {
    const revision = ++recordRevision, id = requireExpert(), data = await query("expert", { agentId: id, seq, textOffset: offset, format });
    if (id !== expertId || revision !== recordRevision) return;
    eventDetail.hidden = false; eventDetail.open = true; eventBody.textContent = text(data.text); eventBody.classList.toggle("pbot-raw", format === "json");
    eventPaging.replaceChildren(element("span", `记录 ${seq} · ${offset + 1}–${offset + text(data.text).length} / ${data.totalLength}`));
    button(eventPaging, format === "text" ? "查看原始事件" : "查看正文", () => loadRecord(seq, 0, format === "text" ? "json" : "text"));
    if (offset) button(eventPaging, "从头读取", () => loadRecord(seq, 0, format));
    if (typeof data.nextOffset === "number") button(eventPaging, "继续读取", () => loadRecord(seq, data.nextOffset as number, format));
  }
  async function loadExpert() {
    if (!expertId) return;
    const revision = ++expertRevision, id = expertId, data = await query("expert", { agentId: id, ...(expertOffset === undefined ? {} : { offset: expertOffset }) });
    if (id !== expertId || revision !== expertRevision) return;
    showExpert(record(data.agent)); const actualOffset = Number(data.offset), key = `${id}:${data.cursor}:${actualOffset}`;
    if (key === expertPageKey) return; expertPageKey = key; recordControls.replaceChildren();
    button(recordControls, "最新记录", async () => { expertOffset = undefined; await loadExpert(); });
    if (actualOffset > 0) button(recordControls, "上一页", async () => { expertOffset = Math.max(0, actualOffset - 30); await loadExpert(); });
    if (typeof data.nextOffset === "number") button(recordControls, "下一页", async () => { expertOffset = data.nextOffset as number; await loadExpert(); });
    recordControls.append(element("span", `${data.total} 条记录 · 从 ${actualOffset + 1} 开始`));
    const expanded = new Set(Array.from(rawEventList.querySelectorAll("details[open]")).map(item => (item as HTMLElement).dataset.seq));
    eventList.replaceChildren(); rawEventList.replaceChildren();
    const labels: Record<string, string> = { "user/message": "输入", "assistant/message": "专家回复", "tool/result": "工具结果", "turn/end": "本轮结束" };
    for (const event of rows(data.events)) {
      const seq = Number(event.seq), label = event.type === "user/message"
        ? event.source === "user" ? "输入" : event.source === "pbot-input" ? "任务" : undefined : labels[text(event.type)];
      if (label && text(event.preview)) {
        const item = element("article", "", "pbot-event"), meta = group(item, "pbot-row"); meta.append(element("h4", label), note(time(event.time)));
        item.append(block(event.preview)); button(item, "阅读全文", () => loadRecord(seq), "pbot-quiet"); eventList.append(item);
      }
      const item = details(rawEventList, `${seq} · ${event.type} · ${time(event.time)}`); item.dataset.seq = text(seq); item.open = expanded.has(text(seq));
      item.append(block(event.preview)); button(item, "读取事件", () => loadRecord(seq, 0, "json"));
    }
    if (!eventList.childElementCount) eventList.append(empty("还没有对话内容", "发送任务后，可在这里查看专家的回复与工具结果。"));
  }

  const teams = section("teams", "团队"); pageTitle(teams, "团队", "");
  const createTeam = details(teams, "创建团队"), teamForm = form(createTeam), teamName = field(teamForm, "团队名称"), brief = field(teamForm, "共同目标", true);
  teamName.required = true; brief.required = true; teamName.placeholder = "例如：投资研究小组";
  teamForm.append(note("为成员填写职责，留空则不加入。")); const memberFields = group(teamForm);
  submit(teamForm, "创建团队", async () => {
    const members = Array.from(memberFields.querySelectorAll<HTMLInputElement>("input[data-agent-id]")).filter(input => input.value.trim())
      .map(input => ({ agentId: input.dataset.agentId!, role: input.value }));
    const value = objectInput(await command("team", { action: "create", name: teamName.value, brief: brief.value, members }, "团队已创建，可以安排首个批次。"));
    createTeam.open = false; await chooseTeam(text(value.teamId));
  });
  const teamSplit = group(teams, "pbot-split"), teamList = group(teamSplit, "pbot-list"), teamDetail = group(teamSplit, "pbot-detail");
  teamList.setAttribute("aria-label", "团队列表");
  const teamEmpty = empty("选择团队", "查看进展与公共消息。"), teamPanel = group(teamDetail); teamDetail.prepend(teamEmpty); teamPanel.hidden = true;
  const teamHeading = group(teamPanel, "pbot-detail-title"), teamTitle = element("h3"), teamBadge = element("span"); teamHeading.append(teamTitle, teamBadge);
  const teamInfo = group(teamPanel), teamState = block(""); teamState.classList.add("pbot-raw");
  const teamControls = group(teamPanel, "pbot-row"), requireTeam = () => { if (!teamId) throw new Error("请先选择团队。"); return teamId; };
  const pauseButton = button(teamControls, "暂停新安排", async () => { await command("team", { action: "pause", teamId: requireTeam() }, "已暂停新安排；在途任务仍可能完成。"); await loadTeam(); });
  const teamConfig = details(teamPanel, "成员与团队详情"); teamConfig.append(teamState);
  const closeTeamButton = button(teamConfig, "关闭团队", async () => { await command("team", { action: "close", teamId: requireTeam() }, "团队已关闭，成员专家仍可独立使用。"); await loadTeam(); }, "pbot-danger");
  const batch = details(teamPanel, "新批次"), batchForm = form(batch), instruction = field(batchForm, "任务与交付要求", true); instruction.required = true;
  const batchOptions = group(batchForm, "pbot-grid"), mode = select(batchOptions, "讨论模式", [["roundRobin", "轮流讨论"], ["parallel", "并行轮次"]]);
  const rounds = field(batchOptions, "每位成员轮数", false, "2"), concurrency = field(batchOptions, "并发上限", false, "1"), timeout = field(batchOptions, "整批期限（秒）", false, "900");
  for (const [input, max] of [[rounds, 10], [concurrency, 50], [timeout, 86400]] as const) { input.setAttribute("type", "number"); input.setAttribute("min", "1"); input.setAttribute("max", text(max)); input.required = true; }
  const runButton = submit(batchForm, "开始新批次", async () => {
    await command("team", { action: "run", teamId: requireTeam(), instruction: instruction.value,
      mode: mode.value, rounds: Number(rounds.value), maxConcurrent: Number(concurrency.value), timeoutSeconds: Number(timeout.value) }, "新批次已开始。"); await loadTeam();
  });
  const publicCard = group(teamPanel, "pbot-card");
  const postForm = form(publicCard), post = field(postForm, "公共消息", true); post.required = true;
  const replyTo = field(details(postForm, "回复消息"), "回复序号"); replyTo.setAttribute("type", "number"); replyTo.setAttribute("min", "1");
  const postButton = submit(postForm, "发布公共消息", async () => {
    const id = requireTeam(), message = post.value;
    await command("post", { teamId: id, text: message, ...(replyTo.value ? { replyTo: Number(replyTo.value) } : {}) }, "公共消息已发布。");
    if (teamId === id && post.value === message) post.value = "";
    const draft = teamDrafts.get(id); if (draft?.text === message) draft.text = "";
    await loadTeam();
  });
  const teamMessages = group(teamPanel), teamPaging = group(teamPanel, "pbot-pagination");
  let teamAfter = 0, teamPage: Record<string, unknown> = { afterSeq: 0 };
  const teamDrafts = new Map<string, { text: string; reply: string; instruction: string; mode: string; rounds: string; concurrency: string; timeout: string }>();
  async function chooseTeam(id: string) {
    if (id !== teamId) {
      if (teamId) teamDrafts.set(teamId, { text: post.value, reply: replyTo.value, instruction: instruction.value, mode: mode.value, rounds: rounds.value, concurrency: concurrency.value, timeout: timeout.value });
      const draft = teamDrafts.get(id); post.value = draft?.text ?? ""; replyTo.value = draft?.reply ?? ""; instruction.value = draft?.instruction ?? "";
      mode.value = draft?.mode ?? "roundRobin"; rounds.value = draft?.rounds ?? "2"; concurrency.value = draft?.concurrency ?? "1"; timeout.value = draft?.timeout ?? "900";
    }
    teamId = id; teamAfter = 0; teamPageKey = ""; ++teamRevision; teamPanel.hidden = true; teamEmpty.hidden = false;
    teamEmpty.replaceChildren(note("正在读取团队记录…")); renderLists(); await loadTeam({ afterSeq: 0 });
  }
  async function loadTeam(nextPage?: Record<string, unknown>) {
    if (!teamId) return; if (nextPage) teamPage = nextPage; const page = teamPage, id = teamId;
    const revision = ++teamRevision, data = await query("team", { teamId: id, ...page }); if (id !== teamId || revision !== teamRevision) return;
    const team = record(data.team), messages = record(data.page), run = object(team.run) ? team.run : undefined;
    teamPanel.hidden = false; teamEmpty.hidden = true; teamTitle.textContent = text(team.name); teamBadge.replaceChildren(badge(team.closed ? "closed" : run?.state ?? "open"));
    teamInfo.replaceChildren(block(team.brief), facts([["成员", rows(team.members).map(member => `${member.name} · ${member.role}`).join("\n")],
      ["批次进展", run ? `已安排 ${run.scheduled} · 已交付 ${run.published} · 在途 ${team.activeCount}` : "尚未开始"],
      ...(run?.reason ? [["暂停原因", run.reason] as [string, unknown]] : [])]));
    teamState.textContent = JSON.stringify(team, null, 2);
    enabled(pauseButton, !team.closed && run?.state === "running"); enabled(closeTeamButton, !team.closed);
    enabled(runButton, !team.closed && run?.state !== "running" && Number(team.activeCount) === 0); enabled(postButton, !team.closed);
    const key = JSON.stringify([id, page, messages]); if (key === teamPageKey) return; teamPageKey = key;
    teamMessages.replaceChildren(); teamPaging.replaceChildren();
    for (const message of rows(messages.messages)) {
      const author = record(message.author), item = element("article", "", "pbot-message"), meta = group(item, "pbot-row");
      meta.append(element("h4", text(author.name)), note(`#${message.seq}${message.replyTo ? ` · 回复 #${message.replyTo}` : ""}`)); item.append(block(message.text));
      if (typeof message.nextOffset === "number") button(item, "继续读取这条消息", () => loadTeam({ seq: message.seq, offset: message.nextOffset }), "pbot-quiet");
      teamMessages.append(item);
    }
    if (!teamMessages.childElementCount) teamMessages.append(empty("还没有公共消息", "发布资料或开启批次后，成员会在这里共享结果。"));
    button(teamPaging, "从第一条读取", async () => { teamAfter = 0; await loadTeam({ afterSeq: 0 }); });
    if (typeof messages.nextAfterSeq === "number") button(teamPaging, "后续消息", async () => { teamAfter = messages.nextAfterSeq as number; await loadTeam({ afterSeq: teamAfter }); });
    if (page.seq !== undefined) button(teamPaging, "返回消息列表", () => loadTeam({ afterSeq: teamAfter }));
  }

  const history = section("history", "历史"); pageTitle(history, "历史", "");
  const searchForm = form(history); searchForm.className = "pbot-search";
  const historyQuery = field(searchForm, "关键词"), host = select(searchForm, "来源", [["", "全部"], ["pi", "Pi"], ["dsh", "dsh"]]);
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
    if (!keepFilters) historySearch = { query: historyQuery.value, ...(host.value ? { host: host.value } : {}),
      ...(historyFrom.value ? { from: new Date(historyFrom.value).toISOString() } : {}), ...(historyTo.value ? { to: new Date(historyTo.value).toISOString() } : {}) };
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
    historyNode.replaceChildren(element("h3", text(node.name)), note(`${text(node.host)} · ${time(node.from)} · ${node.completed ? "原交互已完成" : "原交互未确认完成"}`),
      block(node.text || "摘要尚未生成，可展开下级记录阅读原文。")); warnings(historyNode, data.warnings);
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

  const expertButtons = new Map<string, HTMLButtonElement>(), teamButtons = new Map<string, HTMLButtonElement>();
  function syncList(container: HTMLElement, buttons: Map<string, HTMLButtonElement>, values: Record<string, unknown>[], kind: "agent" | "team") {
    const ids = new Set(values.map(value => text(value[kind + "Id"])));
    for (const [id, node] of buttons) if (!ids.has(id)) { node.remove(); buttons.delete(id); }
    container.querySelector(":scope > .pbot-empty")?.remove();
    for (const value of values) {
      const id = text(value[kind + "Id"]), state = kind === "agent" ? value.state : value.closed ? "closed" : object(value.run) ? value.run.state : "open";
      let node = buttons.get(id);
      if (!node) { node = button(container, "", () => kind === "agent" ? chooseExpert(id) : chooseTeam(id), "pbot-list-item"); buttons.set(id, node); }
      node.setAttribute("aria-label", text(value.name)); node.setAttribute("aria-pressed", String(id === (kind === "agent" ? expertId : teamId)));
      const signature = JSON.stringify([value.name, state, value.activity, value.brief]);
      if (node.dataset.content !== signature) {
        node.dataset.content = signature; node.replaceChildren(); const row = group(node, "pbot-between"); row.append(element("strong", text(value.name)), badge(state));
        if (kind === "team" || !["idle", "stopped"].includes(text(state))) node.append(note(text(kind === "agent" ? value.activity : value.brief)));
      }
      node.hidden = kind === "agent" && !`${value.name} ${stateLabel(state)}`.toLowerCase().includes(expertFilter.value.trim().toLowerCase());
    }
    if (!values.length || [...buttons.values()].every(node => node.hidden)) {
      container.append(empty(values.length ? "没有匹配的专家" : kind === "agent" ? "还没有专家" : "还没有团队", values.length ? "调整名称或状态关键词。" : kind === "agent" ? "展开上方“创建专家”开始。" : "先创建专家，再为成员分配职责。"));
    }
  }
  function renderLists() {
    if (!snapshot) return;
    syncList(expertList, expertButtons, rows(snapshot.agents), "agent"); syncList(teamList, teamButtons, rows(snapshot.teams), "team");
  }
  expertFilter.addEventListener("input", renderLists);
  function renderSnapshot() {
    if (!snapshot) return;
    location.textContent = text(snapshot.workspaceRoot).split(/[\\/]/).filter(Boolean).at(-1) ?? ""; location.title = text(snapshot.workspaceRoot);
    if (snapshot.enabled === false) {
      const configuration = record(snapshot.configuration);
      counts.textContent = configuration.error ? "Personal Bot 配置错误" : "Personal Bot 未启用";
      workspaceInfo.replaceChildren(facts([["状态", configuration.error ? "配置错误" : "未启用"], ["工作区", snapshot.workspaceRoot], ["配置文件", configuration.path]]),
        note(configuration.error ? "修复配置文件后执行 /pbot init。" : "执行 /pbot init，或点击下方按钮初始化并启用。"));
      pythonInfo.replaceChildren(note("启用工作区后自动准备共享 Python 环境。"));
      materials.hidden = false; initializeButton.textContent = "初始化并启用";
      enabled(initializeButton, !configuration.error);
      for (const [id, control] of tabs) enabled(control, id === "status");
      enabled(pythonButton, false); activate("status");
      statusBody.textContent = JSON.stringify(snapshot, null, 2);
      if (configuration.error) inform(text(configuration.error), "error");
      return;
    }
    for (const control of tabs.values()) enabled(control, true);
    materials.hidden = false; initializeButton.textContent = "准备目录"; enabled(initializeButton, true);
    const agents = rows(snapshot.agents), teams = rows(snapshot.teams), python = record(snapshot.python), history = record(snapshot.history);
    tabCounts.get("experts")!.textContent = text(agents.length); tabCounts.get("teams")!.textContent = text(teams.length);
    const active = agents.filter(agent => ["starting", "busy", "stopping"].includes(text(agent.state))).length;
    counts.textContent = `Personal Bot 已启动 · 专家 ${agents.length} · 执行中 ${active} · 团队 ${teams.length}`;
    const model = object(snapshot.model) ? snapshot.model : {};
    workspaceInfo.replaceChildren(facts([["状态", "已启动"], ["工作区", snapshot.workspaceRoot], ["配置文件", record(snapshot.configuration).path], ["模型", model.model || "尚未选择"], ["Provider", model.provider || "—"],
      ["历史", history.organizing ? "整理中" : history.pending === null ? "查询时更新索引" : `${history.pending} 项待整理`]]));
    pythonInfo.replaceChildren(element("h3", "Python"), badge(python.state));
    if (python.error) pythonInfo.append(element("p", text(python.error), "pbot-warning"));
    enabled(pythonButton, python.state !== "preparing");
    const { agents: _agents, teams: _teams, ...summary } = snapshot; statusBody.textContent = JSON.stringify(summary, null, 2);
    if (snapshot.controlError) inform(text(snapshot.controlError), "error"); renderLists();
    const owned = agents.filter(value => value.owned), ids = new Set(owned.map(agent => text(agent.agentId)));
    for (const input of memberFields.querySelectorAll<HTMLInputElement>("input[data-agent-id]")) if (!ids.has(input.dataset.agentId!)) input.parentElement?.remove();
    memberFields.querySelector(":scope > p")?.remove();
    for (const agent of owned) {
      const id = text(agent.agentId); let input = Array.from(memberFields.querySelectorAll<HTMLInputElement>("input[data-agent-id]")).find(input => input.dataset.agentId === id);
      if (!input) { input = field(memberFields, `${agent.name} · 职责`) as HTMLInputElement; input.dataset.agentId = id; }
      const label = `${agent.name} · 职责`; input.setAttribute("aria-label", label); input.parentElement!.querySelector("span")!.textContent = label;
    }
    if (!owned.length) memberFields.append(note("还没有可加入的专家，请先在专家页创建。"));
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
      await refresh(); if (tab === "experts" && expertId) await loadExpert(); if (tab === "teams" && teamId) await loadTeam();
      if (pollError) { inform("连接已恢复，状态已更新。"); pollError = false; }
    } catch (error) {
      if (!closed) { connection.textContent = "连接中断 · 正在重试"; if (!pollError) inform("读取状态失败：" + String(error), "error"); pollError = true; }
    } finally { if (!closed) timer = window.setTimeout(() => { void poll(); }, 2000); }
  }
  void poll();
}
