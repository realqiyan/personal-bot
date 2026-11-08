import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { SessionId } from "@deepseek-ai/dsh-session";
import { extractSessionEventText } from "@deepseek-ai/dsh-session-query";
import { Type, type Static } from "typebox";
import { json, type Json } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";
import { historyInput } from "../../tools/history/contract.js";
import { executeHistory } from "../../tools/history/actions.js";
import { pbotReadRemote } from "../../ui/dsh/remote.js";
import type { DshWorkspaces, DshWorkspace } from "./workspace.js";

const requestSchema = Type.Object({ parentSessionId: Type.String({ minLength: 1 }), input: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
const expertSchema = Type.Object({ agentId: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), seq: Type.Optional(Type.Integer({ minimum: 0 })),
  textOffset: Type.Optional(Type.Integer({ minimum: 0 })), textLimit: Type.Optional(Type.Integer({ minimum: 2, maximum: 24000 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])) }, { additionalProperties: false });
const teamSchema = Type.Object({ teamId: Type.String({ minLength: 1 }), afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  seq: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }, { additionalProperties: false });
const validRequest = schema(requestSchema), validExpert = schema(expertSchema), validTeam = schema(teamSchema);

export function dshStatus(workspaces: DshWorkspaces, workspace: DshWorkspace): Json {
  workspace.check();
  const agents = workspace.agents.list(workspace.owner);
  return json({ host: "dsh", release: packageVersion, enabled: true, state: "running", workspaceRoot: workspace.root, sessionId: workspace.agent.id,
    model: workspace.agent.model.current() ?? null, python: workspaces.python.status,
    controlError: workspace.controlError ?? null, history: workspace.history.status,
    agents, teams: workspace.teams.list(workspace.owner, agents) });
}

/** Status remains available when this workspace has not opted in. */
export async function dshWorkspaceStatus(workspaces: DshWorkspaces, agent: Agent): Promise<Json> {
  const { root, configuration } = await workspaces.configuration(agent);
  if (!configuration.enabled) return json({ host: "dsh", release: packageVersion, enabled: false,
    state: configuration.error ? "error" : "disabled", nextStep: configuration.error ? configuration.error : "/pbot init",
    workspaceRoot: root, sessionId: agent.id, configuration, model: agent.model.current() ?? null, agents: [], teams: [] });
  return json({ ...dshStatus(workspaces, await workspaces.get(agent)) as Record<string, Json>, configuration });
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
  async expert(request: Json, signal: AbortSignal): Promise<Json> {
    const current = await this.workspace(request, signal), { workspace, input } = current;
    requireThat(validExpert(input), "专家记录查询参数无效。");
    const args = input as Static<typeof expertSchema>;
    const view = workspace.agents.status(args.agentId, workspace.owner);
    using observation = await this.ctx.sessionQuery.observeSession(SessionId(view.agentId), { projectionMode: "none", signal: current.signal });
    workspace.check(); current.signal.throwIfAborted();
    const header = observation.header;
    requireThat(header.id === view.agentId && header.cwd === view.cwd && header.parentSession === workspace.agent.id &&
      header.origin === "subagent" && !header.isSeeded, "原生专家记录的身份或归属不匹配。");
    const events = observation.events;
    if (args.seq !== undefined) {
      const event = events.find(value => value.seq === args.seq);
      requireThat(event, "原生记录位置不存在。");
      const text = (args.format === "text" ? extractSessionEventText(event) : "") || JSON.stringify(event, null, 2), offset = args.textOffset ?? 0;
      requireThat(offset <= text.length, "原生记录分页位置超出范围。");
      let end = Math.min(text.length, offset + (args.textLimit ?? 12000));
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      return json({ agent: view, cursor: observation.cursor, seq: event.seq, offset, text: text.slice(offset, end),
        totalLength: text.length, nextOffset: end < text.length ? end : null });
    }
    const limit = args.limit ?? 30, offset = args.offset ?? Math.max(0, events.length - limit);
    requireThat(offset <= events.length, "原生记录分页位置超出范围。");
    return json({ agent: view, header, cursor: observation.cursor, total: events.length, offset,
      nextOffset: offset + limit < events.length ? offset + limit : null,
      events: events.slice(offset, offset + limit).map(event => ({ seq: event.seq, type: event.type, time: event.time,
        ...(event.type === "user/message" ? { source: event.data.source.kind } : {}), preview: extractSessionEventText(event).slice(0, 800) })) });
  }

  @Remote
  async team(request: Json, signal: AbortSignal): Promise<Json> {
    const { workspace, input } = await this.workspace(request, signal);
    requireThat(validTeam(input), "团队记录查询参数无效。");
    const args = input as Static<typeof teamSchema>;
    return json({ team: workspace.teams.status(args.teamId, workspace.owner, workspace.agents.list(workspace.owner)),
      page: workspace.teams.read(args.teamId, { kind: "user", owner: workspace.owner }, args) });
  }

  @Remote
  async history(request: Json, signal: AbortSignal): Promise<Json> {
    const current = await this.workspace(request, signal), { workspace, input } = current;
    const result = await executeHistory(workspace.history, historyInput(input), { host: "dsh", sessionId: workspace.agent.id }, current.signal);
    workspace.check(); current.signal.throwIfAborted(); return json(result);
  }
}

declare module "@deepseek-ai/cordis" { interface Context { pbotManagement: PbotManagement } }

export function registerDshManagement(ctx: Context, workspaces: DshWorkspaces) {
  ctx.typert.register({ package: pbotReadRemote.package, face: "host", schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: pbotReadRemote.descriptors });
  return new PbotManagement(ctx, workspaces);
}
