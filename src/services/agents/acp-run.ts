import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentDescriptor, AgentMessage } from "../../model/agent.js";
import type { AcpAnswer, AcpPermission } from "../../model/acp.js";
import { AgentFiles, launch } from "../../storage/agent-files.js";
import { acpAnswer, acpInput, acpPermission, acpPermissionReply, acpReport } from "../../storage/acp-files.js";
import { AgentRun } from "./agent-run.js";

export interface AcpProgress { kind: "text" | "thought" | "tool" | "activity"; text?: string; messageId?: string; activity?: string }
export class AcpAnswerBuffer {
  #text = "";
  #messageId: string | undefined;
  get text() { return this.#text; }
  reset() { this.#text = ""; this.#messageId = undefined; }
  update(value: AcpProgress) {
    if (value.kind === "tool") this.reset();
    if (value.kind !== "text") return;
    if (value.messageId && value.messageId !== this.#messageId) this.#text = "";
    this.#messageId = value.messageId; this.#text += value.text ?? "";
  }
}
export interface AcpWork {
  readonly signal: AbortSignal;
  prompt(request: AgentMessage): Promise<{ stopReason: string }>;
  cancel(): Promise<void>;
}

/** ACP prompt completion is the receipt boundary; final reports publish before completions. */
export class AcpAgentRun {
  readonly execution: AgentRun;
  readonly #answer = new AcpAnswerBuffer();
  #lastActivity = 0;
  #stopping = false;
  #work: Promise<void> | undefined;
  #stop: Promise<void> | undefined;
  #failure: unknown;
  constructor(readonly files: AgentFiles, readonly descriptor: AgentDescriptor, readonly generation: string,
    readonly work: AcpWork, readonly exactAnswer: boolean) {
    this.execution = new AgentRun(files, descriptor.agentId, generation);
  }
  private get id() { return this.descriptor.agentId; }
  private current() { return this.files.read(this.id, "launch.json", launch).generation === this.generation; }
  update(value: AcpProgress) {
    if (!this.execution.current || !this.current()) return;
    this.#answer.update(value);
    if (Date.now() - this.#lastActivity >= 500) {
      this.#lastActivity = Date.now();
      this.execution.save({ state: this.#stopping ? "stopping" : "busy", activity: value.activity ?? (value.kind === "text" ? "回答" : "思考") });
    }
  }
  async permission(description: string, options: AcpPermission["options"], signal: AbortSignal): Promise<string | null> {
    const requestId = randomUUID(), request = { generation: this.generation, requestId, description, options };
    this.files.write(this.id, "permissions/" + requestId + ".json", request, acpPermission, true);
    this.execution.save({ state: "busy", activity: "等待确认" });
    while (!signal.aborted && !this.#stopping && this.current() && !this.files.read(this.id, "launch.json", launch).stop) {
      const reply = this.files.optional(this.id, "permissions/" + requestId + "-reply.json", acpPermissionReply);
      if (reply?.generation === this.generation) {
        this.execution.save({ state: this.#stopping ? "stopping" : "busy", activity: reply.optionId ? "已获确认" : "确认被拒绝" });
        return reply.optionId;
      }
      await delay(100);
    }
    // Close the request so it no longer shows as pending once the turn or worker has ended.
    if (this.current()) this.files.write(this.id, "permissions/" + requestId + "-reply.json", { generation: this.generation, requestId, optionId: null }, acpPermissionReply, true);
    return null;
  }
  async run() {
    this.execution.recover(); this.execution.save({ state: "idle", activity: "空闲" });
    while (!this.#stopping && this.current() && !this.work.signal.aborted) {
      this.files.check(); if (this.#failure) throw this.#failure;
      if (this.files.read(this.id, "launch.json", launch).stop) { await this.stop(); break; }
      if (!this.#work) {
        const request = this.files.messages(this.id).find(message => message.generation === this.generation && !this.execution.accepted(message.requestId));
        if (request) {
          const pending = this.perform(request).finally(() => { if (this.#work === pending) this.#work = undefined; });
          this.#work = pending;
          void pending.catch(error => { this.#failure = error; });
        }
      }
      await delay(100);
    }
    if (!this.current() && !this.#stopping) await this.stop();
    if (!this.#stopping) await this.#work;
    if (this.work.signal.aborted && !this.#stopping) throw this.work.signal.reason;
  }
  private async perform(request: AgentMessage) {
    this.#answer.reset();
    this.execution.claim(request.requestId); this.execution.enter(request.requestId); this.execution.begin();
    this.files.write(this.id, "acp-input.json", { generation: this.generation, requestId: request.requestId }, acpInput);
    let result: AcpAnswer;
    try {
      const end = await this.work.prompt(request);
      let snapshot: AcpAnswer | undefined;
      if (this.exactAnswer) {
        snapshot = this.files.optional(this.id, "acp-answer.json", acpAnswer);
        if (snapshot?.generation !== this.generation || snapshot.requestId !== request.requestId) snapshot = undefined;
      }
      const answer = this.exactAnswer ? snapshot?.answer ?? "" : this.#answer.text;
      const state = end.stopReason === "cancelled" || this.#stopping ? "cancelled" : end.stopReason === "end_turn" &&
        (!this.exactAnswer || snapshot?.state === "completed") && answer.trim() ? "completed" : "failed";
      if (state === "completed") this.execution.consume(request.requestId);
      result = { generation: this.generation, requestId: request.requestId, state, answer,
        ...(state === "failed" ? { error: snapshot?.error ?? "ACP 工作未产生有效最终回答：" + end.stopReason } : {}) };
    } catch (error) {
      result = { generation: this.generation, requestId: request.requestId, answer: this.#answer.text,
        state: this.#stopping || this.files.read(this.id, "launch.json", launch).stop ? "cancelled" : "failed", error: String(error) };
    }
    if (!this.current()) return;
    const cycleId = this.execution.current!.cycleId;
    this.files.write(this.id, "reports/" + cycleId + ".json", { generation: this.generation, cycleId, text: result.answer }, acpReport, true);
    this.execution.finish({ state: this.work.signal.aborted && !this.#stopping ? "interrupted" : result.state,
      position: "acp:" + cycleId, answer: result.answer, ...(result.error ? { error: result.error } : {}) });
  }
  settled() { return this.#work; }
  stop(): Promise<void> {
    return this.#stop ??= (async () => {
      this.#stopping = true;
      if (this.current()) this.execution.save({ state: "stopping", activity: "停止" });
      const pending = this.#work;
      if (!pending) return;
      const grace = new AbortController();
      try {
        const cancelAndSettle = this.work.cancel().catch(() => {}).then(() => pending);
        await Promise.race([cancelAndSettle, delay(4000, undefined, { signal: grace.signal })]);
      } finally { grace.abort(); }
    })();
  }
}
