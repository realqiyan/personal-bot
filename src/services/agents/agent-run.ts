import { randomUUID } from "node:crypto";
import { AgentFiles, launch, status, cycle } from "../../storage/agent-files.js";
import { requireThat } from "../../common/validation.js";
import type { AgentCycle, AgentStatus } from "../../model/agent.js";

/** Durable request receipts and work cycles, independent of a host's event vocabulary. */
export class AgentRun {
  readonly #accepted = new Set<string>();
  readonly #assigned = new Set<string>();
  readonly #consumed = new Set<string>();
  readonly #queued: string[] = [];
  readonly #saved: AgentStatus | undefined;
  #interactive = false;
  #humanConsumed = false;
  #current: AgentCycle | undefined;
  #snapshot: AgentStatus;
  constructor(readonly files: AgentFiles, readonly id: string, readonly generation: string) {
    const saved = files.optional(id, "status.json", status);
    this.#saved = saved?.generation === generation ? saved : undefined;
    const requests = new Set(files.messages(id).filter(m => m.generation === generation).map(m => m.requestId));
    for (const requestId of this.#saved?.accepted ?? []) if (requests.has(requestId)) this.#accepted.add(requestId);
    this.#snapshot = { generation, state: "starting", activity: "启动", updatedAt: Date.now() };
  }
  get current(): Readonly<AgentCycle> | undefined { return this.#current; }
  get state() { return this.#snapshot.state; }
  get pending() { return this.#queued.length; }
  get interactive() { return this.#interactive; }
  accepted(requestId: string) { return this.#accepted.has(requestId); }
  save(patch: Pick<AgentStatus, "state" | "activity"> & { error?: string }) {
    this.#snapshot = { ...this.#snapshot, ...patch, updatedAt: Date.now(), accepted: [...this.#accepted] };
    if (this.#current) this.#snapshot.cycle = structuredClone(this.#current);
    this.files.write(this.id, "status.json", this.#snapshot, status);
  }
  /** A receipt is durable before input is passed to the native execution boundary. */
  claim(requestId: string) {
    requireThat(this.files.messages(this.id).some(m => m.requestId === requestId && m.generation === this.generation), "请求不属于当前启动代次。");
    this.#accepted.add(requestId);
    this.save({ state: "busy", activity: "消息已领取" });
  }
  /** Native ownership associates work even when preparation fails before model admission. */
  enter(requestId: string) {
    requireThat(this.#accepted.has(requestId), "请求尚未领取。");
    if (this.#assigned.has(requestId)) return;
    this.#assigned.add(requestId);
    if (this.#current) {
      if (!this.#current.requestIds.includes(requestId)) this.#current.requestIds.push(requestId);
      if (this.#current.source === "interactive") this.#current.source = "mixed";
    } else if (!this.#queued.includes(requestId)) this.#queued.push(requestId);
    this.save({ state: "busy", activity: "消息已接收" });
  }
  /** Model admission is a separate fact from a native inbox claim. */
  consume(requestId: string) {
    requireThat(this.#accepted.has(requestId), "请求尚未领取。");
    this.#consumed.add(requestId);
    this.enter(requestId);
  }
  cancelQueued(requestId: string) {
    if (!this.#accepted.has(requestId) || this.#assigned.has(requestId)) return;
    const value: AgentCycle = { cycleId: requestId, generation: this.generation,
      startedAt: this.files.read(this.id, "launch.json", launch).startedAt, finishedAt: Date.now(),
      state: "cancelled", leaf: null, requestIds: [requestId], source: "parent" };
    this.files.write(this.id, "completions/" + requestId + ".json", value, cycle, true);
    this.#assigned.add(requestId);
  }
  humanInput() { this.#humanConsumed = true; this.enterHuman(); }
  enterHuman() {
    if (this.#current) {
      if (this.#current.source === "parent") this.#current.source = this.#current.requestIds.length ? "mixed" : "interactive";
    } else this.#interactive = true;
    this.save({ state: "busy", activity: "人工输入" });
  }
  begin() {
    if (!this.#current) {
      const requestIds = this.#queued.splice(0);
      this.#current = { cycleId: randomUUID(), generation: this.generation, startedAt: Date.now(), state: "running", leaf: null,
        requestIds, source: this.#interactive ? requestIds.length ? "mixed" : "interactive" : "parent" };
      this.#interactive = false;
    }
    this.save({ state: "busy", activity: "思考" });
  }
  finish(end: { state: Exclude<AgentCycle["state"], "running">; position: string | null; answer: string; error?: string }) {
    if (!this.#current) return;
    const valid = end.position !== null && end.answer.trim().length > 0 &&
      (this.#current.source !== "parent" || this.#current.requestIds.length > 0) &&
      this.#current.requestIds.every(id => this.#consumed.has(id)) &&
      (this.#current.source === "parent" || this.#humanConsumed);
    this.#current = { ...this.#current, finishedAt: Date.now(), leaf: end.position,
      state: end.state === "completed" && !valid ? "failed" : end.state,
      ...(end.error ? { error: end.error } : end.state === "completed" && !valid ? { error: "没有已消费的请求或有效最终回答。" } : {}) };
    this.files.write(this.id, "completions/" + this.#current.cycleId + ".json", this.#current, cycle, true);
    this.save({ state: "idle", activity: this.#current.state });
    this.#current = undefined; this.#humanConsumed = false;
  }
  /** Reload seals uncertainty. It never turns a receipt into permission to replay. */
  recover(receipts: Iterable<{ generation: string; requestId: string }> = []) {
    const requests = new Set(this.files.messages(this.id).filter(m => m.generation === this.generation).map(m => m.requestId));
    for (const receipt of receipts) if (receipt.generation === this.generation && requests.has(receipt.requestId)) this.#accepted.add(receipt.requestId);
    const completed = this.files.completions(this.id);
    for (const c of completed) if (c.generation === this.generation) for (const id of c.requestIds) this.#assigned.add(id);
    if (this.#saved?.cycle?.state === "running" && !completed.some(c => c.cycleId === this.#saved!.cycle!.cycleId)) {
      const interrupted: AgentCycle = { ...this.#saved.cycle, state: "interrupted", finishedAt: Date.now() };
      this.files.write(this.id, "completions/" + interrupted.cycleId + ".json", interrupted, cycle, true);
      completed.push(interrupted);
    }
    for (const requestId of this.#accepted) {
      this.#assigned.add(requestId);
      if (completed.some(c => c.generation === this.generation && c.requestIds.includes(requestId))) continue;
      const interrupted: AgentCycle = { cycleId: requestId, generation: this.generation,
        startedAt: this.files.read(this.id, "launch.json", launch).startedAt, finishedAt: Date.now(),
        state: "interrupted", leaf: null, requestIds: [requestId], source: "parent", error: "领取后执行结果不明；未重跑。" };
      this.files.write(this.id, "completions/" + requestId + ".json", interrupted, cycle, true);
    }
  }
}
