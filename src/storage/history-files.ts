import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { HistoryRecord } from "../model/history.js";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import { readJsonFile, writeJsonFile } from "./atomic-json.js";
import { fileId } from "./file-access.js";

function record(value: unknown): HistoryRecord {
  requireThat(object(value) && typeof value.id === "string" && typeof value.sessionId === "string" &&
    typeof value.name === "string" && Array.isArray(value.nodes), "历史索引无效。");
  return value as unknown as HistoryRecord;
}
export class HistoryFiles {
  constructor(readonly directory: string) {}
  list(workspace?: string) {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => name.endsWith(".json"))
      .map(name => readJsonFile(this.directory, name, record))
      .filter(value => workspace === undefined || ("workspace" in value && value.workspace === workspace));
  }
  save(value: HistoryRecord) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeJsonFile(this.directory, fileId(value.id) + ".json", value, record);
  }
}
