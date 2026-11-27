import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AgentFiles, descriptor, launch, status } from "../../storage/agent-files.js";
import { acpModelState, acpReference } from "../../storage/acp-files.js";
import type { AcpModelSelection, AcpSessionReference } from "../../model/acp.js";
import { AcpAgentRun } from "../../services/agents/acp-run.js";
import { openAcp } from "../../integrations/acp/connection.js";
import { acpExecutable } from "../../integrations/acp/executable.js";
import { acpContent } from "../../integrations/acp/input.js";
import { toAcpMcpServers } from "../../integrations/acp/mcp.js";
import { resolveAcpHarness } from "../../integrations/acp/registry.js";
import { loadWorkspaceContext } from "../../integrations/agent-resources.js";
import { readWorkspaceConfig, workspaceFeatures } from "../../services/workspace/workspace-config.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServers } from "../../services/workspace/workspace-mcp.js";
import { discoverWorkspaceSkills } from "../../services/workspace/workspace-skills.js";
import { object } from "../../common/json.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { packageVersion, releaseLine } from "../../common/version.js";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function sendIpc(message: unknown): Promise<void> {
  return new Promise(resolveSend => {
    if (!process.connected || !process.send) { resolveSend(); return; }
    process.send(message, undefined, undefined, () => resolveSend());
  });
}

function permissionDescription(request: RequestPermissionRequest) {
  const call = request.toolCall;
  const detail = call.rawInput === undefined ? "" : JSON.stringify(call.rawInput);
  return [call.title ?? "工具调用", call.kind ? "类型：" + call.kind : "", call.locations?.length ? "路径：" + call.locations.map(item => item.path).join(", ") : "",
    detail ? "参数：" + (detail.length > 2000 ? detail.slice(0, 2000) + "…" : detail) : ""].filter(Boolean).join("\n");
}

async function runProbe() {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error("ACP 模型探测已取消。"));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const payload = await new Promise<{ reference: AcpSessionReference; cwd: string; provider?: string; model?: string }>((resolvePayload, rejectPayload) => {
      const timer = setTimeout(() => rejectPayload(new Error("缺少 ACP 模型探测参数。")), 5000);
      process.once("message", (value: unknown) => {
        clearTimeout(timer);
        if (!object(value)) { rejectPayload(new Error("ACP 模型探测参数必须是对象。")); return; }
        resolvePayload(value as { reference: AcpSessionReference; cwd: string; provider?: string; model?: string });
      });
      process.once("disconnect", () => { clearTimeout(timer); rejectPayload(new Error("ACP 模型探测通道已断开。")); });
    });
    const reference = acpReference(payload.reference);
    requireThat(typeof payload.cwd === "string" && payload.cwd.length > 0, "缺少 ACP 模型探测目录。");
    const env: NodeJS.ProcessEnv = { ...process.env, ...(reference.env ?? {}) };
    const connection = await openAcp(reference, payload.cwd, env, {
      update() {},
      async permission() { return { outcome: { outcome: "cancelled" } }; },
    }, lifetime.signal);
    try {
      if (payload.model) {
        await connection.configure({
          ...(payload.provider ? { provider: payload.provider } : {}),
          model: payload.model,
        });
      }
      await sendIpc({
        type: "models",
        result: {
          backend: reference.backend,
          ...connection.choices(),
          selection: connection.selection(),
        },
      });
    } finally {
      await connection.close();
    }
  } catch (error) {
    await sendIpc({ type: "error", error: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    lifetime.abort();
    if (process.connected) process.disconnect();
  }
}

async function runWorker(args: string[]) {
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
    const configuration = await readWorkspaceConfig(d.workspace);
    const features = workspaceFeatures(configuration);
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PBOT_SUBAGENT_RUN_ID: id!,
      PBOT_SUBAGENT_DIR: directory!,
      PBOT_SUBAGENT_GENERATION: generation!,
      ...(validating ? { PBOT_ACP_VALIDATE: "1" } : {}),
    };
    const prepared = harness.prepareLaunch
      ? await harness.prepareLaunch({ reference, cwd: d.cwd, directory: directory!, packageRoot, options: d.options, env: baseEnv, features })
      : { command: { ...reference, args: [...reference.args] }, env: { ...baseEnv, ...(reference.env ?? {}) } };

    let prompt: string | undefined;
    if (!exactAnswer) {
      const workspaceSkills = features.skills && !harness.nativeWorkspaceSkills && !d.options.noSkills
        ? await discoverWorkspaceSkills(d.workspace)
        : [];
      if (features.prompts || workspaceSkills.length > 0) {
        prompt = (await loadWorkspaceContext({
          host: reference.backend,
          root: d.workspace,
          role: "general-purpose",
          includePrompts: features.prompts,
          workspaceSkills,
        })).text;
      }
    }

    let mcpServers: ReturnType<typeof toAcpMcpServers> | undefined;
    if (features.mcp && !harness.nativeWorkspaceMcp && !validating) {
      const mcpConfig = await readWorkspaceMcpConfig(d.workspace);
      if (mcpConfig.present) {
        const resolved = resolveWorkspaceMcpServers(d.workspace, mcpConfig, prepared.env);
        if (resolved.length) mcpServers = toAcpMcpServers(resolved);
      }
    }

    // Only publish acp-model.json after requested model/thinking options are applied so callers can detect startup readiness.
    let configured = false;
    const saveSelection = (selection: AcpModelSelection) => {
      if (validating || !configured) return;
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
      async permission(request, signal) {
        if (!execution) return { outcome: { outcome: "cancelled" } };
        const policy = reference.permission ?? "ask";
        const pick = (...kinds: string[]) => kinds.map(kind => request.options.find(item => item.kind === kind)).find(Boolean)?.optionId;
        // ask forwards the request to the parent session; allow/deny follow the workspace's explicit configuration.
        const optionId = policy === "allow" ? pick("allow_once", "allow_always")
          : policy === "deny" ? pick("reject_once", "reject_always")
          : await execution.permission(permissionDescription(request),
            request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })), signal);
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      },
      async elicitation(request, signal) {
        if (!execution) return { action: "cancel" };
        if (request.mode === "form") {
          const schema = "requestedSchema" in request && object(request.requestedSchema)
            ? request.requestedSchema
            : { type: "object", properties: {} };
          const reply = await execution.elicitation({ mode: "form", message: request.message, schema }, signal);
          if (reply.action === "accept") return { action: "accept", content: reply.content ?? {} };
          return reply.action === "decline" ? { action: "decline" } : { action: "cancel" };
        }
        if (request.mode === "url" && "url" in request && typeof request.url === "string" && request.url.length > 0) {
          const reply = await execution.elicitation({ mode: "url", message: request.message, url: request.url }, signal);
          if (reply.action === "accept") return { action: "accept" };
          return reply.action === "decline" ? { action: "decline" } : { action: "cancel" };
        }
        return { action: "decline" };
      },
    }, lifetime.signal, {
      harness,
      ...(prompt ? { systemPrompt: prompt } : {}),
      ...(prepared.sessionMeta ? { sessionMeta: prepared.sessionMeta } : {}),
      ...(prepared.defaultThinking ? { defaultThinking: prepared.defaultThinking } : {}),
      ...(mcpServers ? { mcpServers } : {}),
    });

    try {
      requireThat(!prompt || !harness.requireSystemPrompt || connection.systemPrompt,
        `${reference.backend} ACP 后端需要支持 systemPrompt，以加载专家职责与工作区资料。`);
      if (validating) { await sendIpc({ type: "validated" }); return; }
      if (reference.sessionId === null) await connection.configure(d.options);
      requireThat(files.read(id!, "launch.json", launch).generation === generation && !files.read(id!, "launch.json", launch).stop, "ACP 启动已取消。");
      files.write(id!, "acp-session.json", {
        ...reference,
        sessionId: harness.eagerSessionId || reference.sessionId !== null ? connection.sessionId : null,
        capabilities: connection.capabilities,
      }, acpReference);
      configured = true;
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
    if (validating) { await sendIpc({ type: "error", error: errorMessage(error) }); }
    else if (files.read(id, "launch.json", launch).generation === generation) {
      const stopped = files.read(id, "launch.json", launch).stop;
      const patch = { state: stopped ? "stopped" as const : "error" as const, activity: stopped ? "已停止" : "ACP 执行失败", ...(stopped ? {} : { error: errorMessage(error) }) };
      if (execution) execution.execution.save(patch);
      else files.write(id, "status.json", { generation, ...patch, updatedAt: Date.now() }, status);
    }
    process.exitCode = 1;
  } finally {
    lifetime.abort();
    if (process.connected) process.disconnect();
    // Keep child processes in this worker's process group so forced release covers descendants.
  }
}

async function runOneShotPrompt() {
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error("ACP 摘要任务已取消。"));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const payload = await new Promise<{
      reference: AcpSessionReference;
      cwd: string;
      system: string;
      prompt: string;
      model?: string;
      thinking?: string;
    }>((resolvePayload, rejectPayload) => {
      const timer = setTimeout(() => rejectPayload(new Error("缺少 ACP 摘要任务参数。")), 5000);
      process.once("message", (value: unknown) => {
        clearTimeout(timer);
        if (!object(value)) { rejectPayload(new Error("ACP 摘要任务参数必须是对象。")); return; }
        resolvePayload(value as {
          reference: AcpSessionReference;
          cwd: string;
          system: string;
          prompt: string;
          model?: string;
          thinking?: string;
        });
      });
      process.once("disconnect", () => { clearTimeout(timer); rejectPayload(new Error("ACP 摘要任务通道已断开。")); });
    });
    const reference = acpReference(payload.reference);
    requireThat(typeof payload.cwd === "string" && payload.cwd.length > 0, "缺少 ACP 摘要工作目录。");
    requireThat(typeof payload.prompt === "string" && payload.prompt.trim().length > 0, "缺少 ACP 摘要输入内容。");
    const harness = resolveAcpHarness(reference.backend);
    const packageRoot = resolve(resourceRoot, "..");
    // Mark as managed subagent so no host (Pi, dsh, Claude, Antigravity) ever records raw history for summary runs.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(reference.env ?? {}),
      PBOT_SUBAGENT_RUN_ID: "pbot-summary-" + randomUUID(),
      ...(reference.backend === "pi" ? {
        PBOT_SUMMARY_WORKER: "1",
        PI_OFFLINE: "1",
        PBOT_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND ?? acpExecutable("pi", "pi"),
        PI_ACP_PI_COMMAND: join(packageRoot, "bin/pbot-pi-acp.mjs"),
      } : {}),
    };
    let collecting = false;
    let text = "";
    const connection = await openAcp(
      reference,
      payload.cwd,
      env,
      {
        update(update) {
          if (collecting && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            text += update.content.text;
          }
        },
        async permission() {
          return { outcome: { outcome: "cancelled" } };
        },
      },
      lifetime.signal,
      {
        harness,
        ...(payload.system ? { systemPrompt: payload.system } : {}),
      },
    );
    try {
      if (payload.model || payload.thinking) {
        const parsedModel = payload.model
          ? (harness.parseModelValue ? harness.parseModelValue(payload.model) : { model: payload.model })
          : undefined;
        await connection.configure({
          ...(parsedModel?.provider ? { provider: parsedModel.provider } : {}),
          ...(parsedModel?.model ? { model: parsedModel.model } : {}),
          ...(payload.thinking ? { thinking: payload.thinking } : {}),
        });
      }
      const promptText = !connection.systemPrompt && payload.system
        ? `${payload.system}\n\n---\n\n${payload.prompt}`
        : payload.prompt;
      collecting = true;
      await connection.prompt([{ type: "text", text: promptText }]);
      let cleaned = text;
      if (connection.startupInfo) {
        if (cleaned.startsWith(connection.startupInfo)) {
          cleaned = cleaned.slice(connection.startupInfo.length);
        } else {
          const trimmedInfo = connection.startupInfo.trim();
          const trimmedText = cleaned.trimStart();
          if (trimmedInfo && trimmedText.startsWith(trimmedInfo)) {
            cleaned = trimmedText.slice(trimmedInfo.length);
          }
        }
      }
      const answer = cleaned.trim();
      requireThat(answer.length > 0, "ACP 摘要返回为空。");
      await sendIpc({ type: "answer", text: answer });
    } finally {
      await connection.close();
    }
  } catch (error) {
    await sendIpc({ type: "error", error: errorMessage(error) });
    process.exitCode = 1;
  } finally {
    lifetime.abort();
    if (process.connected) process.disconnect();
  }
}

const args = process.argv.slice(2);
if (args.includes("--probe")) await runProbe();
else if (args.includes("--prompt")) await runOneShotPrompt();
else await runWorker(args);
