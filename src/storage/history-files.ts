import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { HistoryHost, HistoryRecord } from "../model/history.js";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";
import { fileId } from "./file-access.js";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function record(value: unknown): HistoryRecord {
  requireThat(object(value) && typeof value.id === "string" && typeof value.sessionId === "string" &&
    typeof value.name === "string" && Array.isArray(value.nodes), "历史索引无效。");
  for (const node of value.nodes) requireThat(object(node) && typeof node.id === "string" &&
    ["session", "exchange", "summary"].includes(String(node.kind)) && Number.isInteger(node.level) &&
    strings(node.entryIds) && strings(node.parents) && strings(node.children) && typeof node.text === "string" &&
    typeof node.from === "string" && typeof node.to === "string" && typeof node.ready === "boolean" && typeof node.completed === "boolean", "历史节点无效。");
  const result = value as unknown as HistoryRecord, ids = new Set(result.nodes.map(node => node.id));
  requireThat(ids.size === result.nodes.length && result.nodes.some(node => node.id === result.id && node.kind === "session") &&
    result.nodes.every(node => [...node.parents, ...node.children].every(id => ids.has(id))), "历史节点关系无效。");
  return result;
}
export class HistoryFiles {
  constructor(readonly directory: string, readonly host: HistoryHost = "pi") {}
  list(workspace?: string) {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => name.endsWith(".json"))
      .map(name => readJsonFile(this.directory, name, value => {
        const result = record(value);
        requireThat(this.host !== "dsh" || result.id.startsWith("dsh-"), "dsh 历史根 ID 缺少来源前缀。");
        return result;
      }))
      .filter(value => workspace === undefined || ("workspace" in value && value.workspace === workspace));
  }
  /** The callback is synchronous: no SDK reads or model work can hold this source's write lock. */
  control<T>(operation: () => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, ".write");
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("历史来源写锁被占用：" + this.host), { code: "PBOT_HISTORY_BUSY" });
      throw error;
    }
    try { return operation(); } finally { rmdirSync(lock); }
  }
  save(value: HistoryRecord) {
    requireThat(this.host !== "dsh" || value.id.startsWith("dsh-"), "dsh 历史根 ID 缺少来源前缀。");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeJsonFile(this.directory, fileId(value.id) + ".json", value, record);
  }
}
