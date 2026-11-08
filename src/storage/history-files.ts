import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryHost, HistoryRecord } from "../model/history.js";
import { canonical, object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { internalPath, readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { fileId } from "./file-access.js";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function record(value: unknown): HistoryRecord {
  requireThat(object(value) && (value.host === "pi" || value.host === "dsh") &&
    typeof value.id === "string" && typeof value.sessionId === "string" &&
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
  #warnings: string[] = [];
  constructor(readonly directory: string, readonly host: HistoryHost = "pi") {}
  get warnings(): readonly string[] { return this.#warnings; }
  list() {
    this.#warnings = [];
    if (!existsSync(this.directory)) return [];
    const records: HistoryRecord[] = [];
    for (const name of readdirSync(this.directory).filter(name => name.endsWith(".json"))) {
      try {
        const value = readJsonFile(this.directory, name, record);
        requireThat(name === fileId(value.id) + ".json", "历史文件名与根 ID 不匹配。");
        if (value.host === this.host) records.push(value);
      } catch (error) { this.#warnings.push(join(this.directory, name) + ": " + String(error)); }
    }
    return records;
  }
  /** Publish each legacy archive with its directory's host before removing the old copy. */
  migrate(root: string) {
    const directory = join(root, "." + this.host, "pbot/history");
    if (!existsSync(directory)) return;
    this.control(() => {
      if (!existsSync(directory)) return;
      const legacyLock = join(directory, ".write");
      mkdirSync(legacyLock, { mode: 0o700 });
      try {
        for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
          const source = internalPath(directory, name), target = internalPath(this.directory, name);
          requireThat(source !== target, "新旧历史目录指向同一位置。");
          const value = readJsonFile(directory, name, value => {
            requireThat(object(value) && (value.host === undefined || value.host === this.host), "旧历史归档与来源目录不匹配。");
            return record({ ...value, host: this.host });
          });
          requireThat(name === fileId(value.id) + ".json", "历史文件名与根 ID 不匹配。");
          if (!writeJsonFile(this.directory, name, value, record, true)) {
            requireThat(canonical(readJsonFile(this.directory, name, record)) === canonical(value),
              "历史归档迁移冲突，请核对新旧文件：" + name);
          }
          syncDirectory(this.directory);
          unlinkSync(source); syncDirectory(directory);
        }
      } finally { rmdirSync(legacyLock); }
      rmdirSync(directory);
      const parent = dirname(directory);
      syncDirectory(parent);
      try { rmdirSync(parent); syncDirectory(dirname(parent)); }
      catch (error) { if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    });
  }
  /** The callback is synchronous: no SDK reads or model work can hold this source's write lock. */
  control<T>(operation: () => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, ".write-" + this.host);
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("历史来源写锁被占用：" + this.host), { code: "PBOT_HISTORY_BUSY" });
      throw error;
    }
    try { return operation(); } finally { rmdirSync(lock); }
  }
  save(value: HistoryRecord) {
    requireThat(value.host === this.host, "历史归档与来源不匹配。");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeJsonFile(this.directory, fileId(value.id) + ".json", value, record);
  }
}
