import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { TeamRecord, TeamReady, TeamLink } from "../model/team.js";
import { AgentFiles } from "./agent-files.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";
import { fileId, privateDirectory } from "./file-access.js";

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
export function teamReady(v: unknown): TeamReady {
  requireThat(object(v) && text(v.generation) && typeof v.ready === "boolean", "团队就绪标记无效。");
  return v as unknown as TeamReady;
}
export function teamRecord(v: unknown): TeamRecord {
  requireThat(object(v) && text(v.teamId) && text(v.release) && text(v.workspace) && text(v.parentSessionId) &&
    (v.parentLeaf === null || text(v.parentLeaf)) && text(v.name) && text(v.brief) && typeof v.closed === "boolean" &&
    Array.isArray(v.members) && v.members.length > 0 && v.members.length <= 50 && Array.isArray(v.runs) && Array.isArray(v.messages), "团队记录无效。");
  fileId(v.teamId);
  const members = new Set<string>(), runs = new Set<string>(), requests = new Map<string, { agentId: string; runId: string }>(), operations = new Set<string>();
  for (const m of v.members) {
    requireThat(object(m) && text(m.agentId) && text(m.role) && !members.has(m.agentId), "团队成员无效或重复。");
    fileId(m.agentId); members.add(m.agentId);
  }
  let running = 0;
  for (const r of v.runs) {
    requireThat(object(r) && text(r.runId) && !runs.has(r.runId) && text(r.instruction) &&
      ["roundRobin", "parallel"].includes(String(r.mode)) && integer(r.rounds, 1) && r.rounds <= 10 &&
      integer(r.maxConcurrent, 1) && r.maxConcurrent <= members.size && (r.mode !== "roundRobin" || r.maxConcurrent === 1) &&
      integer(r.deadlineAt, 1) && ["running", "paused", "finished"].includes(String(r.state)) &&
      (r.reason === undefined || text(r.reason)) && object(r.generations) && Array.isArray(r.issued), "团队批次无效。");
    fileId(r.runId); runs.add(r.runId);
    requireThat(Object.keys(r.generations).length === members.size && [...members].every(id => text((r.generations as Record<string, unknown>)[id])), "团队代次无效。");
    if (r.state === "running") running++;
    const turns = new Set<string>();
    for (const q of r.issued) {
      requireThat(object(q) && text(q.requestId) && !requests.has(q.requestId) && text(q.agentId) && members.has(q.agentId) &&
        q.generation === r.generations[q.agentId] && integer(q.round, 1) && q.round <= r.rounds &&
        integer(q.throughSeq) && q.throughSeq <= v.messages.length && !turns.has(q.agentId + ":" + q.round), "团队请求关联无效。");
      fileId(q.requestId); requests.set(q.requestId, { agentId: q.agentId, runId: r.runId }); turns.add(q.agentId + ":" + q.round);
    }
  }
  requireThat(running <= 1 && (!v.closed || running === 0), "团队运行状态冲突。");
  for (const [i, m] of v.messages.entries()) {
    requireThat(object(m) && m.seq === i + 1 && text(m.operationId) && !operations.has(m.operationId) && typeof m.text === "string" &&
      object(m.author) && ["user", "coordinator", "member"].includes(String(m.author.kind)) && text(m.author.name) &&
      (m.author.kind === "member" ? text(m.author.agentId) && members.has(m.author.agentId) : m.author.agentId === undefined) &&
      (m.replyTo === undefined || (integer(m.replyTo, 1) && m.replyTo <= i)) &&
      (m.runId === undefined || (text(m.runId) && runs.has(m.runId))), "团队消息无效。");
    if (m.source !== undefined) requireThat(object(m.source) && text(m.source.requestId) && text(m.source.cycleId) &&
      requests.get(m.source.requestId)?.agentId === m.author.agentId && requests.get(m.source.requestId)?.runId === m.runId, "团队报告关联无效。");
    operations.add(m.operationId);
  }
  return v as unknown as TeamRecord;
}
export class TeamFiles {
  readonly root: string;
  constructor(readonly agents: AgentFiles) { this.root = join(dirname(agents.root), "teams"); }
  check() { this.agents.check(); }
  read(id: string) {
    const value = readJsonFile(this.root, fileId(id) + "/team.json", teamRecord);
    requireThat(value.teamId === id, "团队路径与身份不匹配。"); return value;
  }
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter(e => !e.name.startsWith(".")).map(e => this.read(e.name));
  }
  save(value: TeamRecord, create = false) {
    this.check(); teamRecord(value);
    let published: boolean;
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.root);
      requireThat(directory.isDirectory() && !directory.isSymbolicLink(), "团队状态必须使用普通目录。");
      if (create) privateDirectory(this.root, fileId(value.teamId));
      published = writeJsonFile(this.root, fileId(value.teamId) + "/team.json", value, teamRecord, create);
    } catch (error) { this.agents.fail(error); throw error; }
    requireThat(published, "团队已存在。");
  }
  ready(id: string) { return this.agents.optional(id, "team-ready.json", teamReady); }
  setReady(id: string, generation: string, ready: boolean) {
    this.agents.write(id, "team-ready.json", { generation, ready }, teamReady);
  }
  links(records = this.list()): Map<string, TeamLink> {
    const result = new Map<string, TeamLink>();
    for (const team of records) for (const run of team.runs) for (const request of run.issued) {
      requireThat(!result.has(request.requestId), "团队请求 ID 重复。");
      result.set(request.requestId, { team, run, request });
    }
    return result;
  }
}
