import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createReadTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { AgentFiles, descriptor, launch, status, cycle } from "../storage/agent-files.js";
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
  const lifetime = new AbortController();
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
    lifetime.signal.throwIfAborted();
    const run = files.read(id, "launch.json", launch);
    requireThat(run.generation === generation && !run.stop, "子会话已停止或启动代次变化。");
    requireThat(python, "子会话尚未就绪。");
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
    current = undefined;
  };
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    save({ state: "stopping", activity: "停止" });
    lifetime.abort(); ctx?.abort();
    await python?.close();
    ctx?.shutdown();
  };
  const pump = async () => {
    if (processing || !ctx || closing) return;
    processing = true;
    try {
      const run = files.read(id, "launch.json", launch);
      if (run.generation !== generation || run.stop) { await shutdown(); return; }
      if (pi.getSessionName() !== run.name) pi.setSessionName(run.name);
      for (const request of files.messages(id)) {
        if (request.generation !== generation || accepted.has(request.requestId)) continue;
        const content: (TextContent | ImageContent)[] = [];
        for (const path of request.files) {
          const output = await createReadTool(d.cwd).execute("file-" + request.requestId, { path }, lifetime.signal);
          content.push(...output.content.filter((p): p is TextContent | ImageContent => p.type === "text" || p.type === "image"));
        }
        content.push({ type: "text", text: request.message || "请处理所附文件。" });
        requireThat(ctx.model, "子会话没有可用模型。");
        requireThat(ctx.modelRegistry.hasConfiguredAuth(ctx.model) || await ctx.modelRegistry.getProviderAuth(ctx.model.provider), "子会话模型未认证，请配置原生 Pi 认证后显式恢复。");
        accepted.add(request.requestId);
        pi.appendEntry("pbot.agent-input", { requestId: request.requestId, generation });
        if (current) { current.requestIds.push(request.requestId); if (current.source === "interactive") current.source = "mixed"; }
        else queuedRequests.push(request.requestId);
        save({ state: "busy", activity: "消息已接收" });
        pi.sendUserMessage(content, ctx.isIdle() ? {} : { deliverAs: request.delivery });
        break;
      }
    } catch (error) {
      save({ state: "error", activity: "控制失败", error: String(error) });
      await shutdown();
    } finally { processing = false; }
  };
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
      requireThat(realpathSync(ctx.cwd) === d.cwd && ctx.sessionManager.getSessionFile() === files.session(id), "子会话工作目录或文件不匹配。");
      for (const entry of ctx.sessionManager.getEntries()) if (entry.type === "custom" && entry.customType === "pbot.agent-input") {
        const receipt = entry.data as { requestId?: string }; if (receipt.requestId) accepted.add(receipt.requestId);
      }
      if (saved?.generation === generation && saved.cycle?.state === "running") {
        const interrupted: AgentCycle = { ...saved.cycle, state: "interrupted", finishedAt: Date.now() };
        if (!files.completions(id).some(c => c.cycleId === interrupted.cycleId)) files.write(id, "completions/" + interrupted.cycleId + ".json", interrupted, cycle, true);
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
      timer = setInterval(() => void pump(), 250); timer.unref(); void pump();
    } catch (error) { save({ state: "error", activity: "启动失败", error: String(error) }); ctx.shutdown(); }
  });
  pi.on("before_agent_start", async event => {
    ensure();
    requireThat(python, "子会话计算环境状态不可用。");
    event.systemPromptOptions.sections.pbot_environment = JSON.stringify({
      workspaceRoot: d.workspace, cwd: d.cwd, resourceRoot, python: python.status,
    });
    event.systemPromptOptions.sections.pbot_workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
    event.systemPromptOptions.sections.pbot_child = await agentText("general-purpose", d.workspace);
  });
  pi.on("input", event => {
    if (event.source !== "extension") {
      if (current) current.source = current.source === "parent" ? "mixed" : current.source;
      else interactive = true;
    }
    return;
  });
  pi.on("agent_start", (_event, context) => {
    ctx = context; startLeaf = ctx.sessionManager.getLeafId();
    current = { cycleId: randomUUID(), generation, startedAt: Date.now(), state: "running", leaf: null,
      requestIds: queuedRequests, source: interactive ? queuedRequests.length ? "mixed" : "interactive" : "parent" };
    queuedRequests = []; interactive = false;
    save({ state: "busy", activity: "思考" });
  });
  pi.on("tool_call", event => {
    try {
      ensure();
      requireThat(event.toolName !== "pbot_agent", "子会话禁止管理和委派。");
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
    if (timer) clearInterval(timer); timer = undefined; closing = true; lifetime.abort();
    if (current) finish(true);
    await python?.close(); restorePython?.();
    if (event.reason !== "reload" && snapshot.state !== "error") save({ state: "stopped", activity: "已停止" });
    ctx = undefined;
  });
}
