import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { packageVersion, releaseLine } from "../../common/version.js";
import { requireThat } from "../../common/validation.js";
import { AgentFiles, descriptor, launch, status, cycle } from "../../storage/agent-files.js";
import type { AgentOwner, AgentOptions, AgentView, AgentDescriptor, AgentCycle, AgentCompletion } from "../../model/agent.js";

export interface AgentHost {
  available(): void;
  alive(id: string): boolean;
  launch(value: AgentDescriptor, directory: string, generation: string): void;
  kill(id: string): void;
  report(file: string, leaf: string | null): string;
}
export class AgentService {
  readonly files: AgentFiles;
  #closed = false;
  constructor(readonly root: string, directory: string, readonly host: AgentHost) { this.files = new AgentFiles(directory); }
  private check() { requireThat(!this.#closed, "子会话服务已关闭。"); }
  private owned(d: AgentDescriptor, owner: AgentOwner) {
    return d.workspace === this.root && d.parentSessionId === owner.sessionId && (d.parentLeaf === null || owner.branch.includes(d.parentLeaf));
  }
  private get(id: string, owner: AgentOwner) {
    this.check(); const d = this.files.read(id, "descriptor.json", descriptor);
    requireThat(this.owned(d, owner), "子会话不属于当前会话分支。");
    requireThat(releaseLine(d.release) === releaseLine(packageVersion), "子会话版本不兼容；请停止后使用匹配版本。"); return d;
  }
  list(owner: AgentOwner): AgentView[] {
    this.check(); return this.files.list().filter(d => d.workspace === this.root && d.parentSessionId === owner.sessionId).map(d => this.view(d, owner));
  }
  private view(d: AgentDescriptor, owner: AgentOwner): AgentView {
    const run = this.files.read(d.agentId, "launch.json", launch);
    const saved = this.files.optional(d.agentId, "status.json", status);
    const current = saved?.generation === run.generation ? saved : undefined;
    const alive = this.host.alive(d.agentId);
    return { ...d, name: run.name, generation: run.generation, owned: this.owned(d, owner),
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
      const request = this.files.enqueue(agentId, [options.message, ...(options.prompts ?? [])].filter(Boolean).join("\n\n"), "steer", files);
      try { this.host.launch(d, this.files.directory(agentId), run.generation); }
      catch (error) {
        this.files.write(agentId, "status.json", { generation: run.generation, state: "error", activity: "启动失败", updatedAt: Date.now(), error: String(error) }, status);
        throw error;
      }
      return { ...this.view(d, owner), requestId: request.requestId, messageStatus: "queued" as const };
    });
  }
  send(id: string, text: string, delivery: "steer" | "followUp", owner: AgentOwner) {
    const d = this.get(id, owner);
    return this.files.control(() => {
      requireThat(this.host.alive(id) && !this.files.read(id, "launch.json", launch).stop, "子会话已停止，请显式 resume。");
      const request = this.files.enqueue(id, text, delivery);
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
  resume(id: string, text: string, owner: AgentOwner) {
    const d = this.get(id, owner); this.host.available();
    return this.files.control(() => {
      requireThat(!this.host.alive(id), "子会话仍在运行。");
      requireThat(this.list(owner).filter(v => this.host.alive(v.agentId)).length < 50, "最多 50 个存活子会话。");
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
      const request = this.files.enqueue(id, text, "steer");
      this.host.launch(d, this.files.directory(id), run.generation);
      return { ...this.view(d, owner), requestId: request.requestId, messageStatus: "queued" as const };
    });
  }
  cycles(id: string, owner: AgentOwner): AgentCycle[] {
    const d = this.get(id, owner), view = this.view(d, owner), values = this.files.completions(id);
    if (view.cycle && !values.some(c => c.cycleId === view.cycle!.cycleId)) {
      values.push(view.state === "stopped" || view.state === "error" ? { ...view.cycle, state: "interrupted", finishedAt: view.cycle.finishedAt ?? Date.now() } : view.cycle);
    }
    if (!values.some(c => c.generation === view.generation) && ["stopped", "error"].includes(view.state)) {
      const run = this.files.read(id, "launch.json", launch);
      values.push({ cycleId: run.generation, generation: run.generation, startedAt: run.startedAt, finishedAt: run.startedAt,
        state: "interrupted", leaf: null, requestIds: [], source: "parent", error: view.error ?? "子进程在交付前退出。" });
    }
    return values;
  }
  read(id: string, owner: AgentOwner, cycleId?: string, offset = 0, limit = 16000) {
    const d = this.get(id, owner), cycles = this.cycles(id, owner);
    const c = cycleId ? cycles.find(v => v.cycleId === cycleId) : cycles.at(-1);
    requireThat(!cycleId || c, "周期不存在。");
    const report = c ? this.host.report(this.files.session(id), c.leaf) : "";
    requireThat(offset <= report.length, "分页位置超出报告。");
    return { ...this.view(d, owner), ...(c ? { cycle: c } : {}), cycles: cycles.map(v => ({ cycleId: v.cycleId, state: v.state })),
      report: report.slice(offset, offset + limit), totalLength: report.length, nextOffset: offset + limit < report.length ? offset + limit : null };
  }
  completions(owner: AgentOwner): AgentCompletion[] {
    return this.list(owner).filter(v => v.owned).flatMap(v => this.cycles(v.agentId, owner).filter(c => c.state !== "running").map(c =>
      ({ agentId: v.agentId, name: v.name, cycle: c, report: this.host.report(this.files.session(v.agentId), c.leaf) })));
  }
  /** Called by the parent scanner; stop remains nonblocking to the model. */
  refresh(owner: AgentOwner) {
    for (const d of this.files.list().filter(d => d.workspace === this.root && d.parentSessionId === owner.sessionId)) {
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
      for (const id of ids) this.requestStop(id);
      const deadline = Date.now() + 5000;
      while (ids.some(id => this.host.alive(id)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      for (const id of ids) if (this.host.alive(id)) this.host.kill(id);
    }
    this.#closed = true;
  }
}
