import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { SessionHeader } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { AgentDescriptor } from "../../model/agent.js";
import { requireThat } from "../../common/validation.js";

function validateHeader(d: AgentDescriptor, header: SessionHeader) {
  requireThat(header.id === d.agentId && header.cwd === d.cwd && header.parentSession === d.parentSessionId &&
    header.origin === "subagent" && !header.isSeeded, "dsh 专家会话身份、父会话或工作目录不匹配。");
}

/** Read access must neither claim a writer nor activate an Agent. */
export async function readDshAgentSession(ctx: Context, d: AgentDescriptor) {
  const reader = await ctx.sessionPersistence.open(SessionId(d.agentId), "read");
  try {
    validateHeader(d, reader.header);
    return { header: reader.header, events: (await reader.read()).events };
  } finally {
    await reader.close();
  }
}

/** An empty Agent is not recoverable until this native barrier has materialized it. */
export async function flushDshAgent(agent: Agent) {
  requireThat(await agent.ctx.sessions.flush(agent.session), "dsh 会话没有持久化屏障。");
}

export async function openDshAgent(ctx: Context, d: AgentDescriptor, parent: Agent, resume: boolean,
  setup: AgentSetup, signal: AbortSignal): Promise<AgentHandle> {
  signal.throwIfAborted();
  requireThat(parent.id === d.parentSessionId && ctx.agents.get(parent.id) === parent, "dsh 父会话已失效。");
  if (resume) await readDshAgentSession(ctx, d);
  await flushDshAgent(parent);
  signal.throwIfAborted();
  const compose: AgentSetup = async (agentCtx, agent) => {
    validateHeader(d, agent.session.header);
    if (resume) agent.inbox.clear();
    const commit = await setup(agentCtx, agent);
    await flushDshAgent(agent);
    return commit;
  };
  const agentOptions = { ...(d.options.provider ? { provider: d.options.provider } : {}),
    ...(d.options.model ? { model: d.options.model } : {}),
    ...(d.options.thinking ? { reasoningEffort: ReasoningEffortId(d.options.thinking) } : {}) };
  return resume
    ? ctx.agents.resume({ resumeSessionId: SessionId(d.agentId), parentAgent: parent, agentOptions, setup: compose, signal })
    : ctx.agents.create({ sessionId: SessionId(d.agentId), parentAgent: parent,
      meta: { cwd: d.cwd, parentSession: parent.id, origin: "subagent", delegationDepth: 1 },
      agentOptions, setup: compose, signal });
}

/** A report refers to one durable turn boundary, never the latest answer. */
export async function readDshReport(ctx: Context, d: AgentDescriptor, reference: string) {
  const match = /^dsh:(0|[1-9]\d*)$/.exec(reference);
  requireThat(match, "dsh 报告位置无效。");
  const end = Number(match[1]);
  requireThat(Number.isSafeInteger(end), "dsh 报告位置无效。");
  const { events } = await readDshAgentSession(ctx, d);
  const boundary = events[end];
  requireThat(boundary?.type === "turn/end", "dsh 报告结束位置不存在。");
  const last = events.slice(0, end).findLast(event => event.type === "assistant/message" && event.data.turn === boundary.data.turn);
  return last?.type === "assistant/message"
    ? last.data.message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
}
