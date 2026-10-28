import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { packageVersion, releaseLine } from "../../common/version.js";
import { requireThat } from "../../common/validation.js";
import { AgentFiles, descriptor, launch, status, cycle } from "../../storage/agent-files.js";
import { TeamFiles } from "../../storage/team-files.js";
import type { TeamAgent, TeamInput } from "../../model/team.js";
import type { AgentOwner, AgentOptions, AgentDescriptor, AgentCycle, AgentCompletion } from "../../model/agent.js";

export interface AgentHost {
  available(): void;
  alive(id: string): boolean;
  validateSession(value: AgentDescriptor, file: string): void;
  launch(value: AgentDescriptor, directory: string, generation: string, sessionFile: string | null): void;
  kill(id: string): void;
  report(value: AgentDescriptor, file: string, leaf: string): string;
}
export class AgentService {
  readonly files: AgentFiles;
  readonly teamFiles: TeamFiles;
  #closed = false;
  constructor(readonly root: string, directory: string, readonly host: AgentHost) {
    this.files = new AgentFiles(directory); this.teamFiles = new TeamFiles(this.files);
  }
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
    const alive = this.host.alive(d.agentId);
    return { ...d, name: run.name, generation: run.generation, owned: this.owned(d, owner), alive,
      state: alive ? run.stop ? "stopping" : current?.state ?? "starting" : current?.state === "error" ? "error" : "stopped",
      activity: alive ? current?.activity ?? "启动" : current?.error ?? "已停止",
      ...(current?.cycle ? { cycle: current.cycle } : {}), ...(current?.error ? { error: current.error } : {}) };
  }
  start(options: AgentOptions, owner: AgentOwner) {
    this.check(); this.host.available();
    options = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    requireThat(options.provider && options.model, "请选择可在子进程使用的模型。");
    return this.files.control(() => {
      requireThat(this.list(owner).filter(v => this.host.alive(v.agentId)).length < 50, "最多 50 个存活子会话；请先停止一个空闲会话。");
      const agentId = randomUUID();
      const cwd = realpathSync(resolve(this.root, options.cwd ?? "."));
      const files = (options.files ?? []).map(p => realpathSync(resolve(this.root, p)));
      const d: AgentDescriptor = { agentId, release: packageVersion, workspace: this.root, cwd,
        parentSessionId: owner.sessionId, parentLeaf: owner.leaf, createdAt: Date.now(), options: { ...options, files, cwd } };
      const run = { generation: randomUUID(), name: options.name ?? agentId.slice(0, 8), sequence: 0, stop: false, startedAt: Date.now() };
      this.files.create(d, run);
      const initial = [options.message, ...(options.prompts ?? [])].filter(Boolean).join("\n\n");
      const request = initial || files.length ? this.files.enqueue(agentId, initial, "steer", files) : undefined;
      try { this.host.launch(d, this.files.directory(agentId), run.generation, this.files.session(agentId)); }
      catch (error) {
        this.files.write(agentId, "status.json", { generation: run.generation, state: "error", activity: "启动失败", updatedAt: Date.now(), error: String(error) }, status);
        throw error;
      }
      return { ...this.view(d, owner), ...(request ? { requestId: request.requestId, messageStatus: "queued" as const } : {}) };
    });
  }
  send(id: string, text: string, delivery: "steer" | "followUp", owner: AgentOwner) {
    const d = this.get(id, owner);
    return this.files.control(() => {
      requireThat(this.host.alive(id) && !this.files.read(id, "launch.json", launch).stop, "子会话已停止，请显式 resume。");
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
  }
  enter(id: string, owner: AgentOwner) {
    const d = this.get(id, owner);
    if (this.host.alive(id)) {
      requireThat(!this.files.read(id, "launch.json", launch).stop, "子会话正在停止，请稍后进入。");
      return this.view(d, owner);
    }
    return this.restart(id, owner);
  }
  resume(id: string, text: string, owner: AgentOwner) {
    return this.restart(id, owner, text);
  }
  private restart(id: string, owner: AgentOwner, text?: string) {
    const d = this.get(id, owner); this.host.available();
    return this.files.control(() => {
      requireThat(!this.host.alive(id), "子会话仍在运行。");
      this.assertPrivate(id);
      requireThat(this.list(owner).filter(v => this.host.alive(v.agentId)).length < 50, "最多 50 个存活子会话。");
      const sessionFile = this.files.session(id);
      if (sessionFile !== null) this.host.validateSession(d, sessionFile);
      const previous = this.files.read(id, "launch.json", launch);
      // The old process is gone: seal its interruption before replacing its generation.
      for (const ended of this.cycles(id, owner)) {
        if (ended.generation === previous.generation && !this.files.completions(id).some(c => c.cycleId === ended.cycleId)) {
          this.files.write(id, "completions/" + ended.cycleId + ".json", ended, cycle, true);
        }
      }
      this.#stopping.delete(id);
      const run = { ...previous, generation: randomUUID(), sequence: 0, stop: false, startedAt: Date.now() };
      this.files.write(id, "launch.json", run, launch);
      const request = text === undefined ? undefined : this.files.enqueue(id, text, "steer");
      this.host.launch(d, this.files.directory(id), run.generation, sessionFile);
      return { ...this.view(d, owner), ...(request ? { requestId: request.requestId, messageStatus: "queued" as const } : {}) };
    });
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
  read(id: string, owner: AgentOwner, cycleId?: string, offset = 0, limit = 16000) {
    const d = this.get(id, owner), cycles = this.cycles(id, owner);
    const c = cycleId ? cycles.find(v => v.cycleId === cycleId) : cycles.at(-1);
    requireThat(!cycleId || c, "周期不存在。");
    const report = c ? this.report(d, c) : "";
    requireThat(offset <= report.length, "分页位置超出报告。");
    return { ...this.view(d, owner), ...(c ? { cycle: c } : {}), cycles: cycles.map(v => ({ cycleId: v.cycleId, state: v.state })),
      report: report.slice(offset, offset + limit), totalLength: report.length, nextOffset: offset + limit < report.length ? offset + limit : null };
  }
  completions(owner: AgentOwner): AgentCompletion[] {
    return this.list(owner).filter(v => v.owned).flatMap(v => this.cycles(v.agentId, owner).filter(c => c.state !== "running").map(c =>
      ({ agentId: v.agentId, name: v.name, cycle: c, report: this.report(v, c) })));
  }
  private report(d: AgentDescriptor, c: AgentCycle) {
    if (c.leaf === null) return "";
    const file = this.files.session(d.agentId);
    requireThat(file !== null, "完成记录缺少原生会话文件引用。");
    return this.host.report(d, file, c.leaf);
  }
  /** Called by the parent scanner; stop remains nonblocking to the model. */
  refresh(owner: AgentOwner) {
    for (const d of this.records(owner)) {
      const run = this.files.read(d.agentId, "launch.json", launch);
      // A stopped request gets its own grace deadline without modifying child status.
      if (!run.stop) this.#stopping.delete(d.agentId);
      if (run.stop && this.host.alive(d.agentId)) {
        const since = this.#stopping.get(d.agentId) ?? Date.now(); this.#stopping.set(d.agentId, since);
        if (Date.now() - since > 5000) this.host.kill(d.agentId);
      }
    }
  }
  readonly #stopping = new Map<string, number>();
  async close(owner?: AgentOwner, preserve = false) {
    if (this.#closed) return;
    if (!preserve && owner) {
      const ids = this.list(owner).filter(v => this.host.alive(v.agentId)).map(v => v.agentId);
      const errors: unknown[] = [];
      for (const id of ids) { try { this.requestStop(id); } catch (error) { errors.push(error); } }
      const deadline = Date.now() + 5000;
      while (ids.some(id => this.host.alive(id)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      for (const id of ids) if (this.host.alive(id)) this.host.kill(id);
      if (errors.length) { this.#closed = true; throw new AggregateError(errors, "停止记录未能保存；已清理子进程。"); }
    }
    this.#closed = true;
  }
}
