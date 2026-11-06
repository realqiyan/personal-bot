import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { packageVersion, releaseLine } from "../../common/version.js";
import { requireThat } from "../../common/validation.js";
import { AgentFiles, descriptor, launch, status, cycle } from "../../storage/agent-files.js";
import { TeamFiles } from "../../storage/team-files.js";
import type { TeamAgent, TeamInput } from "../../model/team.js";
import type { AgentOwner, AgentOptions, AgentDescriptor, AgentCycle, AgentCompletion, AgentSessionReference } from "../../model/agent.js";

export interface AgentHost {
  readonly kind: AgentSessionReference["host"];
  available(): void;
  alive(id: string): boolean;
  validateSession(value: AgentDescriptor, reference: AgentSessionReference): void | Promise<void>;
  launch(value: AgentDescriptor, directory: string, generation: string, reference: AgentSessionReference, resume: boolean, signal: AbortSignal): void | Promise<void>;
  release(id: string, generation: string): void | Promise<void>;
  report(value: AgentDescriptor, reference: AgentSessionReference, leaf: string): string | Promise<string>;
}
export class AgentService {
  readonly files: AgentFiles;
  readonly teamFiles: TeamFiles;
  #closed = false;
  #preserve = false;
  readonly #starting = new Map<string, { generation: string; controller: AbortController; stage: "validate" | "launch" }>();
  readonly #launches = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  readonly #releasing = new Map<string, Promise<void>>();
  constructor(readonly root: string, directory: string, readonly host: AgentHost) {
    this.files = new AgentFiles(directory, host.kind); this.teamFiles = new TeamFiles(this.files);
  }
  private alive(id: string) { return this.#starting.has(id) || this.#releasing.has(id) || this.host.alive(id); }
  private check() { requireThat(!this.#closed, "子会话服务已关闭。"); }
  private owned(d: AgentDescriptor, owner: AgentOwner) {
    return d.workspace === this.root && d.parentSessionId === owner.sessionId && (d.parentLeaf === null || owner.branch.includes(d.parentLeaf));
  }
  private get(id: string, owner: AgentOwner) {
    this.check(); const d = this.files.read(id, "descriptor.json", descriptor);
    requireThat(this.owned(d, owner), "子会话不属于当前会话分支。");
    requireThat(releaseLine(d.release) === releaseLine(packageVersion), "子会话版本不兼容；请停止后使用匹配版本。"); return d;
  }
  private records(owner: AgentOwner) {
    this.check();
    return this.files.list().filter(d => d.workspace === this.root && d.parentSessionId === owner.sessionId &&
      releaseLine(d.release) === releaseLine(packageVersion));
  }
  list(owner: AgentOwner): TeamAgent[] { return this.records(owner).map(d => this.view(d, owner)); }
  private view(d: AgentDescriptor, owner: AgentOwner): TeamAgent {
    const run = this.files.read(d.agentId, "launch.json", launch);
    const saved = this.files.optional(d.agentId, "status.json", status);
    const current = saved?.generation === run.generation ? saved : undefined;
    const alive = this.alive(d.agentId), pending = this.#starting.get(d.agentId);
    const starting = pending && !pending.controller.signal.aborted;
    return { ...d, name: run.name, generation: run.generation, owned: this.owned(d, owner), alive,
      state: alive ? starting ? "starting" : run.stop || pending?.controller.signal.aborted ? "stopping" : current?.state ?? "starting" : current?.state === "error" ? "error" : "stopped",
      activity: starting ? "启动" : alive ? current?.activity ?? "启动" : current?.error ?? "已停止",
      ...(current?.cycle ? { cycle: current.cycle } : {}), ...(current?.error ? { error: current.error } : {}) };
  }
  async start(options: AgentOptions, owner: AgentOwner) {
    this.check(); this.host.available();
    options = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    requireThat(options.provider && options.model, "请选择可在专家会话使用的模型。");
    const prepared = this.files.control(() => {
      requireThat(this.list(owner).filter(v => v.alive).length < 50, "最多 50 个存活或启动中子会话；请先停止一个空闲会话。");
      const agentId = randomUUID();
      const cwd = realpathSync(resolve(this.root, options.cwd ?? "."));
      const files = (options.files ?? []).map(p => realpathSync(resolve(this.root, p)));
      const d: AgentDescriptor = { agentId, release: packageVersion, workspace: this.root, cwd,
        parentSessionId: owner.sessionId, parentLeaf: owner.leaf, createdAt: Date.now(), options: { ...options, files, cwd } };
      const run = { generation: randomUUID(), name: options.name ?? agentId.slice(0, 8), sequence: 0, stop: false, startedAt: Date.now() };
      this.files.create(d, run);
      const initial = [options.message, ...(options.prompts ?? [])].filter(Boolean).join("\n\n");
      const request = initial || files.length ? this.files.enqueue(agentId, initial, "steer", files) : undefined;
      this.#starting.set(agentId, { generation: run.generation, controller: new AbortController(), stage: "launch" });
      return { d, run, request };
    });
    await this.launch(prepared.d, prepared.run.generation);
    return { ...this.view(prepared.d, owner), ...(prepared.request ? { requestId: prepared.request.requestId, messageStatus: "queued" as const } : {}) };
  }
  private async launch(d: AgentDescriptor, generation: string, resume = false) {
    const pending = this.#starting.get(d.agentId);
    requireThat(pending?.generation === generation, "启动预约已失效。");
    const operation = (async () => {
      try {
        await this.host.launch(d, this.files.directory(d.agentId), generation, this.files.reference(d.agentId), resume, pending.controller.signal);
        requireThat(!this.#closed || this.#preserve, "子会话服务已关闭。"); pending.controller.signal.throwIfAborted();
        const run = this.files.read(d.agentId, "launch.json", launch);
        requireThat(run.generation === generation && !run.stop, "子会话启动已取消或代次变化。");
      } catch (error) {
        const run = this.files.read(d.agentId, "launch.json", launch);
        if (run.generation === generation) {
          if (this.host.alive(d.agentId)) await this.release(d.agentId);
          this.files.write(d.agentId, "status.json", { generation, state: run.stop ? "stopped" : "error",
            activity: run.stop ? "已停止" : "启动失败", updatedAt: Date.now(), ...(run.stop ? {} : { error: String(error) }) }, status);
        }
        throw error;
      } finally { if (this.#starting.get(d.agentId) === pending) this.#starting.delete(d.agentId); }
    })();
    this.#launches.add(operation);
    try { await operation; } finally { this.#launches.delete(operation); }
  }
  send(id: string, text: string, delivery: "steer" | "followUp", owner: AgentOwner) {
    const d = this.get(id, owner);
    return this.files.control(() => {
      requireThat(this.alive(id) && this.#starting.get(id)?.stage !== "validate" && !this.files.read(id, "launch.json", launch).stop, "子会话已停止或仍在恢复校验，请等待显式恢复完成。");
      this.assertPrivate(id);
      const request = this.files.enqueue(id, text, delivery);
      return { ...this.view(d, owner), requestId: request.requestId, messageStatus: "queued" as const };
    });
  }
  private assertPrivate(id: string) {
    this.teamFiles.check();
    const run = this.files.read(id, "launch.json", launch), saved = this.files.optional(id, "status.json", status);
    const complete = this.files.completions(id), alive = this.host.alive(id);
    const occupied = this.teamFiles.list().some(t => t.members.some(m => m.agentId === id) && t.runs.some(r =>
      r.state === "running" || r.issued.some(q => q.agentId === id && q.generation === run.generation && alive &&
        saved?.generation === run.generation && saved.accepted?.includes(q.requestId) &&
        !complete.some(c => c.generation === q.generation && c.requestIds.includes(q.requestId)))));
    if (occupied) throw Object.assign(new Error("TEAM_BUSY：请先暂停团队并等待在途工作结束。"), { code: "TEAM_BUSY" });
  }
  enqueueTeam(input: TeamInput, owner: AgentOwner) {
    const d = this.get(input.agentId, owner);
    return this.files.control(() => {
      this.teamFiles.check();
      const team = this.teamFiles.read(input.teamId), run = team.runs.find(r => r.runId === input.runId);
      const q = run?.issued.find(q => q.requestId === input.requestId), ready = this.teamFiles.ready(input.agentId);
      const process = this.files.read(input.agentId, "launch.json", launch);
      const valid = team.workspace === this.root && team.parentSessionId === owner.sessionId &&
        (team.parentLeaf === null || owner.branch.includes(team.parentLeaf)) && !team.closed && run?.state === "running" &&
        run.deadlineAt > Date.now() && q?.agentId === input.agentId && q.generation === input.generation &&
        process.generation === input.generation && !process.stop && this.host.alive(input.agentId) &&
        ready?.ready && ready.generation === input.generation;
      if (!valid) throw Object.assign(new Error("团队安排已失效；未重新执行。"), { code: "TEAM_INPUT_STALE" });
      const request = this.files.enqueue(input.agentId, input.message, "followUp", [], input.requestId);
      return { ...this.view(d, owner), requestId: request.requestId, messageStatus: "queued" as const };
    });
  }
  rename(id: string, name: string, owner: AgentOwner) {
    requireThat(name.trim().length > 0 && name.length <= 64 && !/[\x00-\x1f]/.test(name), "名称必须是 1 到 64 字符的单行文本。");
    const d = this.get(id, owner);
    this.files.control(() => { const run = this.files.read(id, "launch.json", launch); run.name = name; this.files.write(id, "launch.json", run, launch); });
    return this.view(d, owner);
  }
  stop(id: string, owner: AgentOwner) {
    const d = this.get(id, owner); this.requestStop(id); return this.view(d, owner);
  }
  private requestStop(id: string) {
    this.files.control(() => { const run = this.files.read(id, "launch.json", launch); run.stop = true; this.files.write(id, "launch.json", run, launch); });
    this.#starting.get(id)?.controller.abort();
  }
  async enter(id: string, owner: AgentOwner) {
    const d = this.get(id, owner);
    if (this.alive(id)) {
      requireThat(!this.files.read(id, "launch.json", launch).stop, "子会话正在停止，请稍后进入。");
      return this.view(d, owner);
    }
    return this.restart(id, owner);
  }
  resume(id: string, text: string, owner: AgentOwner) {
    return this.restart(id, owner, text);
  }
  private async restart(id: string, owner: AgentOwner, text?: string) {
    const d = this.get(id, owner); this.host.available();
    const reserved = this.files.control(() => {
      requireThat(!this.alive(id), "子会话仍在运行。");
      this.assertPrivate(id);
      requireThat(this.list(owner).filter(v => v.alive).length < 50, "最多 50 个存活或启动中子会话。");
      const previous = this.files.read(id, "launch.json", launch), interrupted = this.cycles(id, owner);
      const pending = { generation: previous.generation, controller: new AbortController(), stage: "validate" as "validate" | "launch" };
      this.#starting.set(id, pending);
      return { previous, interrupted, pending };
    });
    const operation = (async () => {
      await this.host.validateSession(d, this.files.reference(id));
      requireThat(!this.#closed || this.#preserve, "子会话服务已关闭。"); reserved.pending.controller.signal.throwIfAborted();
      const prepared = this.files.control(() => {
        requireThat(!this.host.alive(id) && this.files.read(id, "launch.json", launch).generation === reserved.previous.generation, "子会话已由其他操作恢复。");
        this.assertPrivate(id);
        // Only the generation known to be stopped before validation can be sealed.
        for (const ended of reserved.interrupted) {
          if (ended.generation === reserved.previous.generation && !this.files.completions(id).some(c => c.cycleId === ended.cycleId)) {
            this.files.write(id, "completions/" + ended.cycleId + ".json", ended, cycle, true);
          }
        }
        this.#stopping.delete(id);
        const run = { ...reserved.previous, generation: randomUUID(), sequence: 0, stop: false, startedAt: Date.now() };
        this.files.write(id, "launch.json", run, launch);
        const request = text === undefined ? undefined : this.files.enqueue(id, text, "steer");
        reserved.pending.generation = run.generation;
        reserved.pending.stage = "launch";
        return { run, request };
      });
      await this.launch(d, prepared.run.generation, true);
      return { ...this.view(d, owner), ...(prepared.request ? { requestId: prepared.request.requestId, messageStatus: "queued" as const } : {}) };
    })();
    this.#launches.add(operation);
    try { return await operation; } finally {
      this.#launches.delete(operation);
      if (this.#starting.get(id) === reserved.pending) this.#starting.delete(id);
    }
  }
  cycles(id: string, owner: AgentOwner): AgentCycle[] {
    const d = this.get(id, owner), view = this.view(d, owner), values = this.files.completions(id);
    if (view.cycle && !values.some(c => c.cycleId === view.cycle!.cycleId)) {
      values.push(view.state === "stopped" || view.state === "error" ? { ...view.cycle, state: "interrupted", finishedAt: view.cycle.finishedAt ?? Date.now() } : view.cycle);
    }
    if (["stopped", "error"].includes(view.state)) {
      const run = this.files.read(id, "launch.json", launch), saved = this.files.optional(id, "status.json", status);
      // Preserve receipt-only crash windows before resume replaces the generation and status.
      for (const requestId of saved?.generation === run.generation ? saved.accepted ?? [] : []) {
        if (values.some(c => c.generation === run.generation && c.requestIds.includes(requestId))) continue;
        values.push({ cycleId: requestId, generation: run.generation, startedAt: run.startedAt, finishedAt: Date.now(),
          state: "interrupted", leaf: null, requestIds: [requestId], source: "parent", error: "领取后执行结果不明；未重跑。" });
      }
      if (run.sequence > 0 && !values.some(c => c.generation === view.generation)) values.push({ cycleId: run.generation, generation: run.generation, startedAt: run.startedAt, finishedAt: run.startedAt,
        state: "interrupted", leaf: null, requestIds: [], source: "parent", error: view.error ?? "子进程在交付前退出。" });
    }
    return values;
  }
  status(id: string, owner: AgentOwner) {
    const d = this.get(id, owner), latest = this.cycles(id, owner).at(-1);
    return { ...this.view(d, owner), ...(latest ? { cycle: latest } : {}) };
  }
  async read(id: string, owner: AgentOwner, cycleId?: string, offset = 0, limit = 16000) {
    const d = this.get(id, owner), cycles = this.cycles(id, owner);
    const c = cycleId ? cycles.find(v => v.cycleId === cycleId) : cycles.at(-1);
    requireThat(!cycleId || c, "周期不存在。");
    const report = c ? await this.report(d, c) : "";
    this.check();
    requireThat(offset <= report.length, "分页位置超出报告。");
    return { ...this.view(d, owner), ...(c ? { cycle: c } : {}), cycles: cycles.map(v => ({ cycleId: v.cycleId, state: v.state })),
      report: report.slice(offset, offset + limit), totalLength: report.length, nextOffset: offset + limit < report.length ? offset + limit : null };
  }
  async completions(owner: AgentOwner): Promise<AgentCompletion[]> {
    const values = await Promise.all(this.list(owner).filter(v => v.owned).flatMap(v => this.cycles(v.agentId, owner).filter(c => c.state !== "running").map(async c =>
      ({ agentId: v.agentId, name: v.name, cycle: c, report: await this.report(v, c) }))));
    this.check(); return values;
  }
  private report(d: AgentDescriptor, c: AgentCycle) {
    if (c.leaf === null) return "";
    return this.host.report(d, this.files.reference(d.agentId), c.leaf);
  }
  private release(id: string) {
    let pending = this.#releasing.get(id);
    if (!pending) {
      const generation = this.files.read(id, "launch.json", launch).generation;
      pending = Promise.resolve().then(async () => {
        if (this.files.read(id, "launch.json", launch).generation === generation) await this.host.release(id, generation);
      }).finally(() => this.#releasing.delete(id));
      this.#releasing.set(id, pending);
    }
    return pending;
  }
  /** Called by the parent scanner; stop remains nonblocking to the model. */
  async refresh(owner: AgentOwner) {
    const releases: Promise<void>[] = [];
    for (const d of this.records(owner)) {
      const run = this.files.read(d.agentId, "launch.json", launch);
      if (!run.stop) this.#stopping.delete(d.agentId);
      if (run.stop && this.alive(d.agentId)) {
        this.#starting.get(d.agentId)?.controller.abort();
        const since = this.#stopping.get(d.agentId) ?? Date.now(); this.#stopping.set(d.agentId, since);
        if (Date.now() - since > 5000) releases.push(this.release(d.agentId));
      }
    }
    await Promise.all(releases);
  }
  readonly #stopping = new Map<string, number>();
  close(owner?: AgentOwner, preserve = false) {
    return this.#closing ??= this.dispose(owner, preserve);
  }
  private async dispose(owner?: AgentOwner, preserve = false) {
    if (this.#closed) return;
    const ids = !preserve && owner ? this.list(owner).filter(v => v.alive).map(v => v.agentId) : [];
    this.#closed = true; this.#preserve = preserve;
    const errors: unknown[] = [];
    for (const id of ids) { try { this.requestStop(id); } catch (error) { errors.push(error); } }
    if (!preserve) for (const pending of this.#starting.values()) pending.controller.abort();
    const deadline = Date.now() + 5000;
    while (ids.some(id => this.alive(id)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const released = await Promise.allSettled(ids.filter(id => this.host.alive(id)).map(id => this.release(id)));
    for (const value of released) if (value.status === "rejected") errors.push(value.reason);
    await Promise.allSettled([...this.#launches]);
    if (errors.length) throw new AggregateError(errors, "停止或释放专家失败；请核对仍存活的执行资源。");
  }
}
