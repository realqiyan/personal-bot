import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { requireThat } from "../common/validation.js";
import { syncDirectory } from "./atomic-json.js";

export function fileId(id: string) {
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id), "内部记录 ID 无效。"); return id;
}
export function privateDirectory(root: string, relative: string) {
  const parts = relative.split("/");
  let parent = root;
  for (const part of parts) {
    fileId(part);
    const path = join(parent, part);
    try { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "内部状态目录无效。"); parent = path;
  }
}
