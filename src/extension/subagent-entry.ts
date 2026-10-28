import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createReadTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { AgentFiles, descriptor, launch, status, cycle } from "../storage/agent-files.js";
import { TeamFiles } from "../storage/team-files.js";
import { TeamService } from "../services/agents/team-service.js";
import { teamMessageTool } from "../tools/teams/tool.js";
import { teamBrief, teamContext } from "../integrations/pi/team-context.js";
import { readAgentSession } from "../integrations/pi/pi-agents.js";
import type { TeamLink } from "../model/team.js";
import { PythonEnvironmentService } from "../services/workspace/python-environment-service.js";
import { activatePython } from "../integrations/python-activation.js";
import { authorizeMutation } from "../services/workspace/workspace-files.js";
import { agentText } from "../integrations/pi/agent-resources.js";
import { agentFileTools } from "../integrations/pi/agent-tools.js";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";
import { packageVersion, releaseLine } from "../common/version.js";
import type { AgentCycle, AgentStatus } from "../model/agent.js";

/** Explicit child composition; never installs main commands or approval capabilities. */
export default function subagent(pi: ExtensionAPI) {
  const id = process.env.PBOT_SUBAGENT_RUN_ID, directory = process.env.PBOT_SUBAGENT_DIR, generation = process.env.PBOT_SUBAGENT_GENERATION;
  requireThat(id && directory && generation, "缺少子会话启动身份。");
  const files = new AgentFiles(dirname(realpathSync(directory)));
  requireThat(files.directory(id) === realpathSync(directory), "子会话路径不匹配。");
  const d = files.read(id, "descriptor.json", descriptor);
  requireThat(d.agentId === id && releaseLine(d.release) === releaseLine(packageVersion), "子会话身份或版本无效。");
  requireThat(files.read(id, "launch.json", launch).generation === generation, "子会话启动代次已失效。");
  const teams = new TeamService(d.workspace, files, new TeamFiles(files));
  const lifetime = new AbortController();
  let activeTeam: TeamLink | undefined, pendingPause: string | undefined;
  let ready = false, disposed = false;
  let ctx: ExtensionContext | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let python: PythonEnvironmentService | undefined, restorePython: (() => void) | undefined;
  let processing = false, closing = false, current: AgentCycle | undefined, startLeaf: string | null = null;
  let queuedRequests: string[] = [], interactive = false;
  const accepted = new Set<string>();
  const saved = files.optional(id, "status.json", status);
  let snapshot: AgentStatus = { generation, state: "starting", activity: "启动", updatedAt: Date.now() };
  if (saved?.generation === generation) for (const requestId of saved.accepted ?? []) accepted.add(requestId);
  let lastActivity = 0;
  const save = (patch: Partial<AgentStatus>) => {
    snapshot = { ...snapshot, ...patch, updatedAt: Date.now() };
    if (current) snapshot.cycle = structuredClone(current);
    snapshot.accepted = [...accepted];
    files.write(id, "status.json", snapshot, status);
  };
  const ensure = () => {
    lifetime.signal.throwIfAborted(); files.check();
    const run = files.read(id, "launch.json", launch);
    requireThat(run.generation === generation && !run.stop, "子会话已停止或启动代次变化。");
    requireThat(python, "子会话尚未就绪。");
  };
  const bindSession = () => {
    const file = ctx?.sessionManager.getSessionFile();
    requireThat(file, "子会话必须使用持久原生会话。");
    files.bindSession(id, file);
  };
  const pauseTeam = (reason: string) => {
    pendingPause = reason;
    try { teams.pauseMember(id, reason); pendingPause = undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "PBOT_CONTROL_BUSY") throw error; }
  };
  const finish = (aborted: boolean) => {
    if (!ctx || !current) return;
    const branch = ctx.sessionManager.getBranch();
    const at = startLeaf === null ? -1 : branch.findIndex(e => e.id === startLeaf);
    const last = branch.slice(at + 1).filter(e => e.type === "message" && e.message.role === "assistant").at(-1);
    const assistant = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
    const text = assistant?.content.filter(p => p.type === "text").map(p => p.text).join("\n") ?? "";
    current = { ...current, finishedAt: Date.now(), leaf: assistant ? ctx.sessionManager.getLeafId() : null,
      state: aborted ? "cancelled" : assistant?.stopReason === "stop" && text.trim() ? "completed" : "failed",
      ...(!assistant || assistant.stopReason !== "stop" ? { error: assistant?.errorMessage ?? "没有有效最终回答。" } : {}) };
    files.write(id, "completions/" + current.cycleId + ".json", current, cycle, true);
    save({ state: "idle", activity: current.state });
    current = undefined; activeTeam = undefined;
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    lifetime.abort(); ctx?.abort();
    try {
      teams.files.setReady(id, generation, false); ready = false;
      pauseTeam("成员停止");
      save({ state: "stopping", activity: "停止" });
    } finally { try { await python?.close(); } finally { ctx?.shutdown(); } }
  };
  const pump = async () => {
    if (processing || !ctx || closing) return;
    processing = true;
    try {
      const run = files.read(id, "launch.json", launch);
      if (run.generation !== generation || run.stop) { await shutdown(); return; }
      if (pi.getSessionName() !== run.name) pi.setSessionName(run.name);
      if (pendingPause) { pauseTeam(pendingPause); if (pendingPause) return; }
      const capable = pi.getActiveTools().includes("pbot_team_message");
      if (capable !== ready) {
        teams.files.setReady(id, generation, capable); ready = capable;
        if (!ready) pauseTeam("成员团队工具已停用");
      }
      if (activeTeam) {
        if (Date.now() >= activeTeam.run.deadlineAt) {
          pauseTeam("已到期限");
          if (!interactive && current?.source !== "mixed") {
            ctx.abort();
            if (!current && ctx.isIdle()) await shutdown();
          }
        }
        return;
      }
      const links = teams.links();
      for (const request of files.messages(id)) {
        if (request.generation !== generation || accepted.has(request.requestId)) continue;
        const link = links.get(request.requestId);
        if (link && (link.team.closed || link.run.state !== "running" || link.run.deadlineAt <= Date.now())) continue;
        if (link && (!ctx.isIdle() || ctx.hasPendingMessages() || current || interactive || queuedRequests.length)) break;
        const content: (TextContent | ImageContent)[] = [];
        for (const path of request.files) {
          const output = await createReadTool(d.cwd).execute("file-" + request.requestId, { path }, lifetime.signal);
          content.push(...output.content.filter((p): p is TextContent | ImageContent => p.type === "text" || p.type === "image"));
        }
        content.push({ type: "text", text: request.message || "请处理所附文件。" });
        requireThat(ctx.model, "子会话没有可用模型。");
        requireThat(ctx.modelRegistry.hasConfiguredAuth(ctx.model) || await ctx.modelRegistry.getProviderAuth(ctx.model.provider), "子会话模型未认证，请配置原生 Pi 认证后显式恢复。");
        ensure();
        const accept = () => {
          bindSession();
          accepted.add(request.requestId);
          pi.appendEntry("pbot.agent-input", { requestId: request.requestId, generation });
          if (current) { current.requestIds.push(request.requestId); if (current.source === "interactive") current.source = "mixed"; }
          else queuedRequests.push(request.requestId);
          save({ state: "busy", activity: "消息已接收" });
        };
        if (link) {
          if (!ctx.isIdle() || ctx.hasPendingMessages() || current || interactive || queuedRequests.length) break;
          activeTeam = teams.claim(id, generation, request.requestId, accept);
          if (!activeTeam) continue;
        } else accept();
        pi.sendUserMessage(content, ctx.isIdle() ? {} : { deliverAs: request.delivery });
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "PBOT_CONTROL_BUSY") return;
      save({ state: "error", activity: "控制失败", error: String(error) });
      await shutdown();
    } finally { processing = false; }
  };
  pi.registerTool({ ...teamMessageTool(teams, { check: ensure }, () => ({
    kind: "member", agentId: id, generation,
    ...(activeTeam && current?.source === "parent" ? { requestId: activeTeam.request.requestId } : {}),
  })), namespace: { name: "pbot", description: "团队公共通信，不提供管理或递归委派。" } });
  pi.on("resources_discover", async () => {
    if (d.options.noSkills) return {};
    const skillPaths = [join(resourceRoot, "skills")];
    const workspaceSkills = join(d.workspace, ".agents/skills");
    try {
      if ((await stat(workspaceSkills)).isDirectory()) skillPaths.push(workspaceSkills);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { skillPaths };
  });
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    try {
      const run = files.read(id, "launch.json", launch);
      requireThat(run.generation === generation && !run.stop, "子会话启动代次已失效或已停止。");
      teams.files.setReady(id, generation, false);
      pauseTeam("子会话载入：旧批次不自动恢复");
      const file = ctx.sessionManager.getSessionFile(), previous = files.session(id);
      requireThat(realpathSync(ctx.cwd) === d.cwd && ctx.sessionManager.getSessionId() === id && file &&
        (previous === null || previous === file), "子会话身份、工作目录或文件不匹配。");
      // Native setup-only sessions have a path but no file. Do not manufacture a conversation to persist it.
      if (previous !== null || existsSync(file)) { readAgentSession(d, file, true); bindSession(); }
      for (const entry of ctx.sessionManager.getEntries()) if (entry.type === "custom" && entry.customType === "pbot.agent-input") {
        const receipt = entry.data as { requestId?: string }; if (receipt.requestId) accepted.add(receipt.requestId);
      }
      if (saved?.generation === generation && saved.cycle?.state === "running") {
        const interrupted: AgentCycle = { ...saved.cycle, state: "interrupted", finishedAt: Date.now() };
        if (!files.completions(id).some(c => c.cycleId === interrupted.cycleId)) files.write(id, "completions/" + interrupted.cycleId + ".json", interrupted, cycle, true);
      }
      // A receipt without a cycle is uncertain, not permission to replay after reload.
      for (const link of teams.links().values()) {
        const q = link.request;
        if (q.agentId !== id || q.generation !== generation || !accepted.has(q.requestId) ||
          files.completions(id).some(c => c.generation === generation && c.requestIds.includes(q.requestId))) continue;
        const interrupted: AgentCycle = { cycleId: q.requestId, generation, startedAt: files.read(id, "launch.json", launch).startedAt,
          finishedAt: Date.now(), state: "interrupted", leaf: null, requestIds: [q.requestId], source: "parent", error: "领取后执行结果不明；未重跑。" };
        files.write(id, "completions/" + interrupted.cycleId + ".json", interrupted, cycle, true);
      }
      const active = pi.getActiveTools();
      for (const tool of agentFileTools(d.cwd, lifetime.signal, async (path, change, cancel) => {
        ensure();
        await authorizeMutation(d.workspace, path, change, async () => false, cancel);
        ensure();
      })) pi.registerTool(tool);
      // Keep the native CLI loadout, including MCP exposure and explicit --tools choices.
      pi.setActiveTools(active);
      python = new PythonEnvironmentService(d.workspace);
      try { const result = await python.setup(lifetime.signal); restorePython = activatePython(result.directory); }
      catch (error) { ctx.ui.notify(String(error), "warning"); }
      save({ state: "idle", activity: "空闲" });
      ready = !pendingPause && pi.getActiveTools().includes("pbot_team_message");
      teams.files.setReady(id, generation, ready);
      const tick = () => void pump().catch(error => {
        closing = true; lifetime.abort(); ctx?.abort();
        console.error("子会话控制失败：", error); ctx?.shutdown();
      });
      timer = setInterval(tick, 250); timer.unref(); tick();
    } catch (error) {
      try { save({ state: "error", activity: "启动失败", error: String(error) }); }
      finally { await shutdown(); }
    }
  });
  pi.on("before_agent_start", async (event, context) => {
    ctx = context; ensure(); bindSession();
    delete event.systemPromptOptions.sections.pbot_team;
    requireThat(python, "子会话计算环境状态不可用。");
    event.systemPromptOptions.sections.pbot_environment = JSON.stringify({
      workspaceRoot: d.workspace, cwd: d.cwd, resourceRoot, python: python.status,
    });
    event.systemPromptOptions.sections.pbot_workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
    event.systemPromptOptions.sections.pbot_child = await agentText("general-purpose", d.workspace);
    if (activeTeam && !interactive && current?.source !== "mixed") {
      const link = teams.links().get(activeTeam.request.requestId);
      requireThat(link, "团队关联不可读取。");
      event.systemPromptOptions.sections.pbot_team = teamBrief(link);
      const message = teamContext(link, context, link.request.throughSeq);
      if (message) return { message };
    }
    return;
  });
  pi.on("turn_end", (event, context) => {
    if (!activeTeam || current?.source !== "parent" || event.outcome === "aborted") return;
    const link = teams.links().get(activeTeam.request.requestId);
    if (!link) return;
    const message = teamContext(link, context);
    if (message) return { entries: [...event.entries, message] };
    return;
  });
  pi.on("input", async event => {
    try { ensure(); bindSession(); }
    catch (error) {
      try { save({ state: "error", activity: "会话引用失败", error: String(error) }); }
      catch { /* A failed store must not allow the native input fallback. */ }
      try { await shutdown(); } catch { ctx?.shutdown(); }
      return { action: "handled" };
    }
    if (event.source !== "extension") {
      if (current) current.source = current.source === "parent" ? "mixed" : current.source;
      else interactive = true;
      save({ state: "busy", activity: "人工输入" });
      pauseTeam("成员由人工接管");
    }
    return;
  });
  pi.on("agent_start", (_event, context) => {
    ctx = context;
    if (current) { save({ state: "busy", activity: "继续思考" }); return; }
    startLeaf = ctx.sessionManager.getLeafId();
    current = { cycleId: randomUUID(), generation, startedAt: Date.now(), state: "running", leaf: null,
      requestIds: queuedRequests, source: interactive ? queuedRequests.length ? "mixed" : "interactive" : "parent" };
    queuedRequests = []; interactive = false;
    save({ state: "busy", activity: "思考" });
  });
  pi.on("tool_call", event => {
    try {
      ensure();
      requireThat(event.toolName !== "pbot_agent" && event.toolName !== "pbot_team", "子会话禁止管理和委派。");
      if (activeTeam && current?.source === "parent" && Date.now() >= activeTeam.run.deadlineAt) {
        ctx?.abort(); throw new Error("团队请求已到期限。");
      }
      save({ state: "busy", activity: event.toolName });
    } catch (error) { return { block: true, reason: String(error) }; }
    return;
  });
  pi.on("message_update", () => { if (current && Date.now() - lastActivity > 1000) { lastActivity = Date.now(); save({ state: "busy", activity: "回答" }); } });
  pi.on("agent_settled", (event, context) => { ctx = context; finish(event.aborted); });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_before_tree", (_event, context) => ({ cancel: !context.isIdle() }));
  pi.on("session_shutdown", async event => {
    if (disposed) return;
    disposed = true;
    if (timer) clearInterval(timer); timer = undefined; closing = true; lifetime.abort();
    try {
      teams.files.setReady(id, generation, false); ready = false;
      pauseTeam("子会话关闭或重新载入");
      if (current) finish(true);
      if (event.reason !== "reload" && snapshot.state !== "error") save({ state: "stopped", activity: "已停止" });
    } finally {
      try { await python?.close(); } finally { restorePython?.(); teams.dispose(); ctx = undefined; }
    }
  });
}
