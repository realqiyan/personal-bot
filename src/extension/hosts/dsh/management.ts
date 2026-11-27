import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Type, type Static } from "typebox";
import { json, type Json } from "../../../common/json.js";
import { requireThat } from "../../../common/validation.js";
import { schema } from "../../../common/schema.js";
import { packageVersion } from "../../../common/version.js";
import { inspectWorkspaceSummaries } from "../../../services/history/summary-runner.js";
import { historyInput } from "../../../tools/history/contract.js";
import { executeHistory } from "../../../tools/history/actions.js";
import { pbotReadRemote } from "../../../ui/dsh/remote.js";
import type { DshWorkspaces, DshWorkspace } from "./workspace.js";

const requestSchema = Type.Object({ parentSessionId: Type.String({ minLength: 1 }), input: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
const validRequest = schema(requestSchema);

export function dshStatus(workspace: DshWorkspace): Json {
  workspace.check();
  return json({
    host: "dsh",
    release: packageVersion,
    enabled: true,
    state: "running",
    workspaceRoot: workspace.root,
    sessionId: workspace.agent.id,
    model: workspace.agent.model.current() ?? null,
    history: workspace.features.history ? inspectWorkspaceSummaries(workspace.root) : null,
  });
}

/** Status remains available when this workspace has not opted in. */
export async function dshWorkspaceStatus(workspaces: DshWorkspaces, agent: Agent): Promise<Json> {
  const { root, configuration } = await workspaces.configuration(agent);
  if (!configuration.enabled) {
    return json({
      host: "dsh",
      release: packageVersion,
      enabled: false,
      state: configuration.error ? "error" : "disabled",
      nextStep: configuration.error ? configuration.error : "/pbot init",
      workspaceRoot: root,
      sessionId: agent.id,
      configuration,
      model: agent.model.current() ?? null,
    });
  }
  return json({ ...dshStatus(await workspaces.get(agent)) as Record<string, Json>, configuration });
}

/** Native Remote owns transport and access checks. These workspace reads do not admit or cancel execution. */
export class PbotManagement extends TypertRemoteService {
  constructor(ctx: Context, private readonly workspaces: DshWorkspaces) { super(ctx, "pbotManagement", { namespace: "pbot" }); }

  private parent(request: Json, signal: AbortSignal) {
    signal.throwIfAborted(); requireThat(validRequest(request), "管理查询参数无效。");
    const args = request as Static<typeof requestSchema>;
    const agent = this.ctx.agents.get(SessionId(args.parentSessionId));
    requireThat(agent, "父会话未加载或已关闭，请在原生会话页面重新打开。");
    return { agent, input: args.input };
  }

  private async workspace(request: Json, signal: AbortSignal) {
    const { agent, input } = this.parent(request, signal);
    const workspace = await this.workspaces.get(agent);
    signal.throwIfAborted(); workspace.check();
    return { workspace, input, signal: AbortSignal.any([signal, workspace.lifetime.signal]) };
  }

  @Remote
  async snapshot(request: Json, signal: AbortSignal): Promise<Json> {
    const { agent, input } = this.parent(request, signal);
    requireThat(input === undefined, "工作区状态查询不接受额外参数。");
    const status = await dshWorkspaceStatus(this.workspaces, agent);
    signal.throwIfAborted(); return status;
  }

  @Remote
  async history(request: Json, signal: AbortSignal): Promise<Json> {
    const current = await this.workspace(request, signal), { workspace, input } = current;
    requireThat(workspace.features.history, "当前工作区已停用历史功能（features.history: false）。");
    const result = executeHistory(workspace.root, historyInput(input), current.signal);
    workspace.check(); current.signal.throwIfAborted(); return json(result);
  }
}

declare module "@deepseek-ai/cordis" { interface Context { pbotManagement: PbotManagement } }

export function registerDshManagement(ctx: Context, workspaces: DshWorkspaces) {
  ctx.typert.register({
    package: pbotReadRemote.package, face: "host", schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: pbotReadRemote.descriptors,
  });
  return new PbotManagement(ctx, workspaces);
}
