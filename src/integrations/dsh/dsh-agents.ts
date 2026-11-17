import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { AgentDescriptor, AgentSessionReference } from "../../model/agent.js";
import type { AgentHost } from "../../services/agents/agent-service.js";
import { requireThat } from "../../common/validation.js";
import { openDshAgent, readDshAgentSession, readDshReport } from "./session.js";

type NativeRun = {
  generation: string;
  controller: AbortController;
  opening: Promise<AgentHandle>;
  handle?: AgentHandle;
  closing?: Promise<void>;
};

/** Native handles belong to the execution component, independently of browser observers. */
export class DshAgents implements AgentHost {
  readonly kind = "dsh";
  readonly #runs = new Map<string, NativeRun>();
  #closed = false;
  constructor(readonly ctx: Context, readonly parent: Agent,
    readonly composition: {
      setup(d: AgentDescriptor, directory: string, generation: string): AgentSetup;
      ready(agent: Agent, generation: string): void;
      stopping(agent: Agent, generation: string): Promise<void>;
    }, readonly lifetime: AbortSignal) {}
  available() {
    this.lifetime.throwIfAborted();
    requireThat(!this.#closed && this.ctx.agents.get(this.parent.id) === this.parent, "dsh 父会话或执行组件已关闭。");
  }
  alive(id: string) {
    const run = this.#runs.get(id);
    return Boolean(this.ctx.agents.get(SessionId(id))) || Boolean(run && (run.closing || !run.handle));
  }
  private reference(d: AgentDescriptor, reference: AgentSessionReference) {
    requireThat(reference.host === "dsh" && reference.sessionId === d.agentId, "不能接管其他宿主或其他身份的原生会话。");
  }
  async validateSession(d: AgentDescriptor, reference: AgentSessionReference) {
    this.available(); this.reference(d, reference);
    requireThat(!this.alive(d.agentId), "原生专家仍被占用，不能恢复。");
    await readDshAgentSession(this.ctx, d);
    requireThat(!this.alive(d.agentId), "原生专家仍被占用，不能恢复。");
  }
  async launch(d: AgentDescriptor, directory: string, generation: string, reference: AgentSessionReference, resume: boolean, signal: AbortSignal) {
    this.available(); this.reference(d, reference);
    requireThat(!this.alive(d.agentId), "dsh 专家仍在运行或释放中。");
    const previous = this.#runs.get(d.agentId);
    if (previous) await this.release(d.agentId, previous.generation);
    signal.throwIfAborted(); this.available();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, this.lifetime, controller.signal]);
    const opening = Promise.resolve().then(() => openDshAgent(this.ctx, d, this.parent, resume,
      this.composition.setup(d, directory, generation), combined));
    const run: NativeRun = { generation, controller, opening };
    this.#runs.set(d.agentId, run);
    try {
      run.handle = await opening;
      if (combined.aborted) {
        await this.release(d.agentId, generation);
        combined.throwIfAborted();
      }
      this.composition.ready(run.handle.agent, generation);
    } catch (error) {
      if (!run.handle && this.#runs.get(d.agentId) === run) this.#runs.delete(d.agentId);
      throw error;
    }
  }
  release(id: string, generation: string) {
    const run = this.#runs.get(id);
    if (!run) return this.ctx.agents.get(SessionId(id)) ? Promise.reject(new Error("原生专家仍由其他执行实例持有；当前组件不能释放。")) : Promise.resolve();
    if (run.generation !== generation) return Promise.resolve();
    if (run.closing) return run.closing;
    run.controller.abort();
    run.closing = (async () => {
      const handle = run.handle ?? await run.opening.catch(() => undefined);
      let failure: unknown;
      if (handle) {
        try { await this.composition.stopping(handle.agent, generation); } catch (error) { failure = error; }
        await handle.dispose();
      }
      if (this.#runs.get(id) === run) this.#runs.delete(id);
      if (failure) throw failure;
    })();
    return run.closing;
  }
  report(d: AgentDescriptor, reference: AgentSessionReference, position: string) {
    this.reference(d, reference);
    return readDshReport(this.ctx, d, position);
  }
  async close() {
    this.#closed = true;
    const results = await Promise.allSettled([...this.#runs].map(([id, run]) => this.release(id, run.generation)));
    const errors = results.flatMap(r => r.status === "rejected" ? [r.reason] : []);
    if (errors.length) throw new AggregateError(errors, "dsh 专家仍有未释放的执行资源。");
  }
}
