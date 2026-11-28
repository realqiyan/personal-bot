import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { canonical } from "../common/json.js";
import { requireThat } from "../common/validation.js";

/** The root must already exist. Never follow aliases inside internal storage. */
export function internalPath(directory: string, relative: string, allowMissingParents = false): string {
  const parts = relative.split("/");
  requireThat(parts.every(part => part && part !== "." && part !== ".." && !/[\\\x00-\x1f]/.test(part)), "内部状态路径无效。");
  const info = lstatSync(directory);
  requireThat(info.isDirectory() && !info.isSymbolicLink(), "内部状态必须使用普通目录。");
  let path = realpathSync(directory);
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    try {
      const info = lstatSync(path);
      requireThat(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()), "内部状态不能使用符号链接或特殊文件。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (!allowMissingParents && index !== parts.length - 1)) throw error;
    }
  }
  return path;
}

export function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Validators return plain data and must reject incomplete contracts. */
export function readJsonFile<T>(directory: string, relative: string, validate: (value: unknown) => T): T {
  const path = internalPath(directory, relative);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireThat(fstatSync(fd).isFile(), "内部状态必须是普通文件。");
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); }
    catch (error) { throw new Error("内部 JSON 文件不可读取：" + relative, { cause: error }); }
    return validate(value);
  } finally { closeSync(fd); }
}

/**
 * A failure after publication does not mean that the old value remains.
 * Callers must stop writes/sends on I/O failure, even if a subsequent read succeeds.
 * createOnly publishes by link, so an existing destination is never overwritten.
 */
export function writeJsonFile<T>(directory: string, relative: string, value: unknown,
  validate: (value: unknown) => T, createOnly = false): boolean {
  const validated = validate(value);
  // Check before touching disk: JSON.stringify alone silently drops unsupported values.
  const expected = canonical(validated);
  const content = JSON.stringify(validated, null, 2) + "\n";
  requireThat(canonical(JSON.parse(content)) === expected, "JSON 序列化不能改变状态值。");
  const path = internalPath(directory, relative), parent = dirname(path);
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    requireThat(internalPath(directory, relative) === path, "内部状态路径已变化。");
    if (createOnly) {
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    } else renameSync(temporary, path);
    syncDirectory(parent);
    return true;
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Serialize a read-modify-write across processes. An undefined replacement means no change. */
export async function updateJsonFile<T>(directory: string, relative: string, validate: (value: unknown) => T,
  update: (current: T | undefined) => T | undefined): Promise<boolean> {
  const lock = internalPath(directory, relative) + ".lock";
  const deadline = Date.now() + 3000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`写锁被占用：${lock}。若写入进程已退出，可手动移除遗留锁目录。`);
      await delay(25);
    }
  }
  try {
    for (;;) {
      let current: T | undefined;
      try { current = readJsonFile(directory, relative, validate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const next = update(current);
      if (next === undefined) return false;
      if (writeJsonFile(directory, relative, next, validate, current === undefined)) return true;
      // An external writer created the file first. Apply the edit to its value.
    }
  } finally { rmdirSync(lock); }
}
