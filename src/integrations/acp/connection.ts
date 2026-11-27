import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpHarnessAdapter, AcpModelSelection, AcpSessionReference } from "../../model/acp.js";
import type { AgentOptions } from "../../model/agent.js";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import { acpChoices, acpModelSelection, acpModelValue, acpThinkingValue } from "./model-selection.js";
import { filterAcpMcpServers } from "./mcp.js";
import { resolveAcpHarness } from "./registry.js";

export function acpFailure(error: unknown): unknown {
  return error instanceof acp.RequestError && error.data !== undefined
    ? new Error(error.message + "：" + JSON.stringify(error.data), { cause: error }) : error;
}

export interface AcpCallbacks {
  update(update: acp.SessionUpdate): void | Promise<void>;
  selection?(selection: AcpModelSelection): void;
  permission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  elicitation?(request: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
}

export interface OpenAcpOptions {
  readonly harness?: AcpHarnessAdapter;
  readonly systemPrompt?: string;
  readonly sessionMeta?: Record<string, unknown>;
  readonly defaultThinking?: string;
  readonly mcpServers?: readonly acp.McpServer[];
}

/** One ACP v1 connection. The worker owns its process group and business state; harness hooks stay in AcpHarnessAdapter. */
export async function openAcp(
  reference: AcpSessionReference,
  cwd: string,
  env: NodeJS.ProcessEnv,
  callbacks: AcpCallbacks,
  signal: AbortSignal,
  openOptions: OpenAcpOptions = {},
) {
  signal.throwIfAborted();
  const harness = openOptions.harness ?? resolveAcpHarness(reference.backend);
  const child = spawn(reference.command, reference.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const lifetime = new AbortController();
  const cancel = AbortSignal.any([signal, lifetime.signal]);
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.once("error", error => lifetime.abort(error));
  child.once("exit", (code, termination) => lifetime.abort(new Error("ACP 进程退出：" + (termination ?? code))));
  child.stderr.resume();
  child.stdin.on("error", () => {});
  let sessionId: string | undefined;
  let options: acp.SessionConfigOption[] = [];
  let resolvedModel: string | undefined;
  const selection = (): AcpModelSelection => ({
    ...acpModelSelection(reference.backend, options, openOptions.defaultThinking),
    ...(resolvedModel ? { resolvedModel } : {}),
  });
  let updating = Promise.resolve();
  let app = acp.client({ name: "personal-bot" })
    .onRequest(acp.methods.client.session.requestPermission, async ctx => {
      if (cancel.aborted || ctx.params.sessionId !== sessionId) return { outcome: { outcome: "cancelled" as const } };
      return callbacks.permission(ctx.params, cancel);
    })
    .onRequest(acp.methods.client.elicitation.create, async ctx => {
      if (cancel.aborted || !callbacks.elicitation) return { action: "cancel" as const };
      if ("sessionId" in ctx.params && ctx.params.sessionId !== sessionId) return { action: "cancel" as const };
      return callbacks.elicitation(ctx.params, cancel);
    })
    .onNotification(acp.methods.client.session.update, ctx => {
      // Load may replay before its response. Output from replay never becomes a new report.
      if (ctx.params.sessionId !== sessionId || cancel.aborted) return;
      updating = updating.then(async () => {
        if (ctx.params.update.sessionUpdate === "config_option_update") {
          const before = acpModelSelection(reference.backend, options);
          options = ctx.params.update.configOptions;
          if (acpModelSelection(reference.backend, options).model !== before.model) resolvedModel = undefined;
          callbacks.selection?.(selection());
        }
        await callbacks.update(ctx.params.update);
      });
      void updating.catch(error => lifetime.abort(error));
      return updating;
    });
  if (harness.customNotificationMethod && harness.parseCustomNotification) {
    const parse = harness.parseCustomNotification;
    app = app.onNotification(harness.customNotificationMethod, (value: unknown) => value, ctx => {
      if (!sessionId || cancel.aborted) return;
      const parsed = parse(ctx.params, sessionId);
      if (!parsed?.resolvedModel) return;
      const model = parsed.resolvedModel;
      updating = updating.then(() => { resolvedModel = model; callbacks.selection?.(selection()); });
      void updating.catch(error => lifetime.abort(error));
      return updating;
    });
  }
  const connection = await app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 8 * 1024 * 1024 }));
  const abort = () => connection.close(cancel.reason);
  cancel.addEventListener("abort", abort, { once: true });
  if (cancel.aborted) abort();
  const connected = AbortSignal.any([cancel, connection.signal]);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      if (sessionId && initialized?.agentCapabilities?.sessionCapabilities?.close && !connection.signal.aborted) {
        await connection.agent.request(acp.methods.agent.session.close, { sessionId }, { cancellationSignal: AbortSignal.timeout(5000), stopWaitingOnCancel: true });
      }
    } finally {
      cancel.removeEventListener("abort", abort);
      connection.close(); child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      const grace = new AbortController();
      try { await Promise.race([exited, delay(1500, undefined, { signal: grace.signal })]); }
      finally { grace.abort(); }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy();
      await exited;
    }
  })();
  let initialized: acp.InitializeResponse | undefined;
  try {
    initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: callbacks.elicitation ? { elicitation: { form: {}, url: {} } } : {},
      clientInfo: { name: "personal-bot", version: packageVersion },
    }, { cancellationSignal: AbortSignal.any([cancel, AbortSignal.timeout(30_000)]), stopWaitingOnCancel: true });
    requireThat(initialized.protocolVersion === 1, "目标宿主没有协商 ACP v1。");
    const advertised = initialized.agentCapabilities;
    const capabilities = {
      resume: Boolean(advertised?.sessionCapabilities?.resume),
      load: advertised?.loadSession === true,
      close: Boolean(advertised?.sessionCapabilities?.close),
    };
    const mcpServers = openOptions.mcpServers?.length
      ? filterAcpMcpServers(openOptions.mcpServers, advertised?.mcpCapabilities)
      : [];
    const setup = {
      cwd,
      mcpServers,
      ...(openOptions.sessionMeta ? { _meta: openOptions.sessionMeta } : {}),
      ...(openOptions.systemPrompt && advertised?.sessionCapabilities?.systemPrompt ? {
        systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: openOptions.systemPrompt }] },
      } : {}),
    };
    let startupInfo: string | undefined;
    if (reference.sessionId === null) {
      const created = await connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, setup, { cancellationSignal: AbortSignal.any([cancel, AbortSignal.timeout(30_000)]), stopWaitingOnCancel: true });
      sessionId = created.sessionId; options = created.configOptions ?? [];
      if (object(created._meta) && object(created._meta.piAcp) && typeof created._meta.piAcp.startupInfo === "string") {
        startupInfo = created._meta.piAcp.startupInfo;
      }
    } else {
      requireThat(capabilities.resume || capabilities.load, "目标 ACP 后端不支持恢复已有会话，请新建 worker。");
      const restored = capabilities.resume
        ? await connection.agent.request<acp.ResumeSessionResponse>(acp.methods.agent.session.resume, { ...setup, sessionId: reference.sessionId }, { cancellationSignal: AbortSignal.any([cancel, AbortSignal.timeout(30_000)]), stopWaitingOnCancel: true })
        : await connection.agent.request<acp.LoadSessionResponse>(acp.methods.agent.session.load, { ...setup, sessionId: reference.sessionId }, { cancellationSignal: AbortSignal.any([cancel, AbortSignal.timeout(30_000)]), stopWaitingOnCancel: true });
      sessionId = reference.sessionId; options = restored.configOptions ?? [];
    }
    requireThat(sessionId, "ACP 后端没有返回会话 ID。");
    const activeId = sessionId;
    return {
      sessionId: activeId, capabilities, signal: connected, close, images: advertised?.promptCapabilities?.image === true,
      systemPrompt: Boolean(advertised?.sessionCapabilities?.systemPrompt),
      ...(startupInfo ? { startupInfo } : {}),
      selection,
      choices: () => acpChoices(options),
      async configure(requested: AgentOptions) {
        requireThat(!requested.provider || requested.model, "provider 需要同时指定目标 model。");
        for (const kind of ["model", "thinking"] as const) {
          const supplied = requested[kind];
          if (supplied === undefined) continue;
          const chosen = kind === "model" ? acpModelValue(reference.backend, options, supplied, requested.provider) : acpThinkingValue(options, supplied);
          const changed = await connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: activeId, ...chosen },
            { cancellationSignal: AbortSignal.any([cancel, AbortSignal.timeout(30_000)]), stopWaitingOnCancel: true });
          await updating;
          options = changed.configOptions;
          if (kind === "model") resolvedModel = undefined;
          callbacks.selection?.(selection());
        }
        return selection();
      },
      async prompt(content: acp.ContentBlock[]) {
        try {
          const response = await connection.agent.request(acp.methods.agent.session.prompt, { sessionId: activeId, prompt: content });
          await updating; cancel.throwIfAborted(); return response;
        } catch (error) { throw acpFailure(error); }
      },
      async cancel() {
        if (!connection.signal.aborted) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: activeId });
      },
    };
  } catch (error) {
    await close().catch(() => {}); throw acpFailure(error);
  }
}
