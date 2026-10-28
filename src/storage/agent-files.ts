import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";
import { fileId, privateDirectory } from "./file-access.js";
import type { AgentDescriptor, AgentLaunch, AgentMessage, AgentStatus, AgentCycle, AgentSessionRef } from "../model/agent.js";

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function descriptor(v: unknown): AgentDescriptor {
  requireThat(object(v) && text(v.agentId) && text(v.release) && text(v.workspace) && text(v.cwd) && text(v.parentSessionId) &&
    (v.parentLeaf === null || text(v.parentLeaf)) && number(v.createdAt) && object(v.options), "子会话身份无效。");
  fileId(v.agentId as string); return v as unknown as AgentDescriptor;
}
export function sessionRef(v: unknown): AgentSessionRef {
  requireThat(object(v) && (v.file === null || (text(v.file) && isAbsolute(v.file) && !v.file.includes("\0"))), "子会话引用无效。");
  return v as unknown as AgentSessionRef;
}
export function launch(v: unknown): AgentLaunch {
  requireThat(object(v) && text(v.generation) && text(v.name) && Number.isSafeInteger(v.sequence) && typeof v.stop === "boolean" && number(v.startedAt), "子会话启动状态无效。");
  return v as unknown as AgentLaunch;
}
export function message(v: unknown): AgentMessage {
  requireThat(object(v) && text(v.requestId) && text(v.generation) && Number.isSafeInteger(v.sequence) && typeof v.message === "string" &&
    ["steer", "followUp"].includes(String(v.delivery)) && Array.isArray(v.files) && v.files.every(text), "子会话消息无效。");
  return v as unknown as AgentMessage;
}
export function cycle(v: unknown): AgentCycle {
  requireThat(object(v) && text(v.cycleId) && text(v.generation) && number(v.startedAt) &&
    ["running", "completed", "failed", "cancelled", "interrupted"].includes(String(v.state)) &&
    (v.leaf === null || text(v.leaf)) && Array.isArray(v.requestIds) && v.requestIds.every(text) &&
    ["parent", "interactive", "mixed"].includes(String(v.source)) && (v.finishedAt === undefined || number(v.finishedAt)), "子会话周期无效。");
  return v as unknown as AgentCycle;
}
export function status(v: unknown): AgentStatus {
  requireThat(object(v) && text(v.generation) && ["starting", "busy", "idle", "stopping", "stopped", "error"].includes(String(v.state)) &&
    typeof v.activity === "string" && number(v.updatedAt), "子会话状态无效。");
  if (v.cycle) cycle(v.cycle); return v as unknown as AgentStatus;
}
export class AgentFiles {
  #failure: unknown;
  constructor(readonly root: string) {}
  check() { if (this.#failure) throw this.#failure; }
  fail(error: unknown) { this.#failure = error; }
  directory(id: string) { return join(this.root, fileId(id)); }
  read<T>(id: string, path: string, parse: (v: unknown) => T): T { return readJsonFile(this.directory(id), path, parse); }
  optional<T>(id: string, path: string, parse: (v: unknown) => T): T | undefined {
    try { return this.read(id, path, parse); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  write<T>(id: string, path: string, value: T, parse: (v: unknown) => T, create = false) {
    this.check(); parse(value);
    let published: boolean;
    try { published = writeJsonFile(this.directory(id), path, value, parse, create); }
    catch (error) { this.fail(error); throw error; }
    requireThat(published, "子会话文件已存在。");
  }
  create(value: AgentDescriptor, run: AgentLaunch) {
    this.check();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.directory(value.agentId), { mode: 0o700 });
    for (const dir of ["inbox", "completions"]) privateDirectory(this.directory(value.agentId), dir);
    this.write(value.agentId, "descriptor.json", value, descriptor, true);
    this.write(value.agentId, "launch.json", run, launch, true);
    this.write(value.agentId, "session-ref.json", { file: null }, sessionRef, true);
  }
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).flatMap(e => {
      const d = this.optional(e.name, "descriptor.json", descriptor); return d ? [d] : [];
    });
  }
  messages(id: string) {
    return readdirSync(join(this.directory(id), "inbox")).filter(n => n.endsWith(".json"))
      .map(n => this.read(id, "inbox/" + n, message)).sort((a, b) => a.sequence - b.sequence);
  }
  completions(id: string) {
    return readdirSync(join(this.directory(id), "completions")).filter(n => n.endsWith(".json"))
      .map(n => this.read(id, "completions/" + n, cycle)).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }
  session(id: string): string | null {
    const ref = this.optional(id, "session-ref.json", sessionRef);
    requireThat(ref, "缺少原生会话引用；不导入旧记录，请重新 start。");
    return ref.file;
  }
  /** The child fixes the native path before accepting input; never reset it to null. */
  bindSession(id: string, file: string) {
    const previous = this.session(id);
    requireThat(previous === null || previous === file, "子会话文件引用不匹配。");
    if (previous === null) this.write(id, "session-ref.json", { file }, sessionRef);
  }
  /** Short controller edits are serialized; an abandoned lock fails closed. */
  control<T>(work: () => T): T {
    this.check();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, ".control");
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw Object.assign(new Error("子会话控制正在进行；稍后重试。崩溃遗留的 .control 需停止相关 Pi 后手动移除。"), { code: "PBOT_CONTROL_BUSY" });
    }
    try { return work(); } finally { rmSync(path, { recursive: true }); }
  }
  enqueue(id: string, text: string, delivery: AgentMessage["delivery"], files: string[] = [], requestId: string = randomUUID()) {
    fileId(requestId);
    const run = this.read(id, "launch.json", launch), previous = this.optional(id, "inbox/" + requestId + ".json", message);
    if (previous) {
      requireThat(previous.generation === run.generation && previous.message === text && previous.delivery === delivery && canonical(previous.files) === canonical(files), "请求 ID 已被不同输入使用。");
      return previous;
    }
    run.sequence++;
    this.write(id, "launch.json", run, launch);
    const value: AgentMessage = { requestId, generation: run.generation, sequence: run.sequence, message: text, delivery, files };
    this.write(id, "inbox/" + value.requestId + ".json", value, message, true); return value;
  }
}
