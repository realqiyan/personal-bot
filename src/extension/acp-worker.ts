import { dirname, resolve } from "node:path";
import { AgentFiles, descriptor, launch, status } from "../storage/agent-files.js";
import { acpModelState, acpReference } from "../storage/acp-files.js";
import type { AcpModelSelection } from "../model/acp.js";
import { AcpAgentRun } from "../services/agents/acp-run.js";
import { openAcp } from "../integrations/acp/connection.js";
import { acpContent } from "../integrations/acp/input.js";
import { resolveAcpHarness } from "../integrations/acp/registry.js";
import { loadWorkspaceContext } from "../integrations/agent-resources.js";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";
import { packageVersion, releaseLine } from "../common/version.js";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const directory = option("--directory"), id = option("--pbot-acp-agent"), generation = option("--generation");
requireThat(directory && id && generation, "缺少 ACP worker 启动信息。");
const files = new AgentFiles(dirname(directory));
requireThat(files.directory(id) === directory, "ACP worker 目录不匹配。");
const d = files.read(id, "descriptor.json", descriptor), reference = files.read(id, "acp-session.json", acpReference);
requireThat(d.agentId === id && releaseLine(d.release) === releaseLine(packageVersion), "ACP worker 身份或版本不匹配。");
const validating = args.includes("--validate"), lifetime = new AbortController();
let execution: AcpAgentRun | undefined;
const stop = () => { void execution?.stop().catch(error => lifetime.abort(error)); if (!execution) lifetime.abort(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

async function main() {
  requireThat(files.read(id!, "launch.json", launch).generation === generation, "ACP worker 启动代次已失效。");
  const harness = resolveAcpHarness(reference.backend);
  const exactAnswer = Boolean(harness.exactAnswer);
  const packageRoot = resolve(resourceRoot, "..");
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PBOT_SUBAGENT_RUN_ID: id!,
    PBOT_SUBAGENT_DIR: directory!,
    PBOT_SUBAGENT_GENERATION: generation!,
    ...(validating ? { PBOT_ACP_VALIDATE: "1" } : {}),
  };
  const prepared = harness.prepareLaunch
    ? await harness.prepareLaunch({ reference, cwd: d.cwd, directory: directory!, packageRoot, options: d.options, env: baseEnv })
    : { command: { ...reference, args: [...reference.args] }, env: { ...baseEnv, ...(reference.env ?? {}) } };

  const prompt = exactAnswer
    ? undefined
    : (await loadWorkspaceContext({ host: reference.backend, root: d.workspace, role: "general-purpose" })).text;

  const saveSelection = (selection: AcpModelSelection) => {
    if (validating) return;
    const run = files.read(id!, "launch.json", launch);
    if (run.generation === generation && !run.stop) files.write(id!, "acp-model.json", { generation, ...selection }, acpModelState);
  };

  const connection = await openAcp(prepared.command, d.cwd, prepared.env, {
    selection: saveSelection,
    update(update) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        execution?.update({ kind: "text", text: update.content.text, ...(update.messageId ? { messageId: update.messageId } : {}) });
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        execution?.update({ kind: "thought" });
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        execution?.update({ kind: update.sessionUpdate === "tool_call" ? "tool" : "activity", activity: update.name ?? update.title ?? "工具" });
      }
    },
    async permission(request) {
      if (!execution) return { outcome: { outcome: "cancelled" } };
      if (process.env.PBOT_ACP_NONINTERACTIVE_PERMISSION === "allow") {
        const allowed = request.options.find(item => item.kind === "allow_once" || item.kind === "allow_always");
        if (allowed) return { outcome: { outcome: "selected", optionId: allowed.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    },
  }, lifetime.signal, {
    harness,
    ...(prompt ? { systemPrompt: prompt } : {}),
    ...(prepared.sessionMeta ? { sessionMeta: prepared.sessionMeta } : {}),
    ...(prepared.defaultThinking ? { defaultThinking: prepared.defaultThinking } : {}),
  });

  try {
    requireThat(!prompt || !harness.requireSystemPrompt || connection.systemPrompt,
      `${reference.backend} ACP 后端需要支持 systemPrompt，以加载专家职责与工作区资料。`);
    if (validating) { if (process.connected) process.send?.({ type: "validated" }); return; }
    if (reference.sessionId === null) await connection.configure(d.options);
    requireThat(files.read(id!, "launch.json", launch).generation === generation && !files.read(id!, "launch.json", launch).stop, "ACP 启动已取消。");
    files.write(id!, "acp-session.json", {
      ...reference,
      sessionId: harness.eagerSessionId || reference.sessionId !== null ? connection.sessionId : null,
      capabilities: connection.capabilities,
    }, acpReference);
    saveSelection(connection.selection());
    let promptInjected = reference.sessionId !== null || connection.systemPrompt;
    execution = new AcpAgentRun(files, d, generation!, {
      signal: connection.signal,
      async prompt(request) {
        const effective = !exactAnswer && prompt && !promptInjected
          ? { ...request, message: prompt + "\n\n---\n\n" + request.message }
          : request;
        promptInjected = true;
        const content = await acpContent(effective, connection.images, connection.signal);
        const run = files.read(id!, "launch.json", launch);
        requireThat(run.generation === generation && !run.stop, "ACP 输入已取消或启动代次变化。");
        connection.signal.throwIfAborted();
        const saved = files.read(id!, "acp-session.json", acpReference);
        if (saved.sessionId === null) files.write(id!, "acp-session.json", { ...saved, sessionId: connection.sessionId }, acpReference);
        return connection.prompt(content);
      },
      cancel: () => connection.cancel(),
    }, exactAnswer);
    await execution.run();
  } finally {
    try { await connection.close(); } finally { await execution?.settled(); }
  }
}

try {
  await main();
  if (!validating && files.read(id, "launch.json", launch).generation === generation) {
    if (execution) execution.execution.save({ state: "stopped", activity: "已停止" });
    else files.write(id, "status.json", { generation, state: "stopped", activity: "已停止", updatedAt: Date.now() }, status);
  }
} catch (error) {
  if (validating) { if (process.connected) process.send?.({ type: "error", error: String(error) }); }
  else if (files.read(id, "launch.json", launch).generation === generation) {
    const stopped = files.read(id, "launch.json", launch).stop;
    const patch = { state: stopped ? "stopped" as const : "error" as const, activity: stopped ? "已停止" : "ACP 执行失败", ...(stopped ? {} : { error: String(error) }) };
    if (execution) execution.execution.save(patch);
    else files.write(id, "status.json", { generation, ...patch, updatedAt: Date.now() }, status);
  }
  process.exitCode = 1;
} finally {
  lifetime.abort();
  if (process.connected) process.disconnect();
  // Keep child processes in this worker's process group so forced release covers descendants.
}
