import { linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { HistoryArchive, HistoryHost, HistoryIdentity, HistoryRecord, HistorySummary, RawHistory } from "../model/history.js";
import { internalPath, readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { fileId, privateDirectory } from "./file-access.js";
import { hierarchicalHistory, isHistoryHost, legacyHistory, matchIdentity, rawHistory, splitLegacy, summaryData } from "./history-format.js";

function ordinaryDirectory(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  requireThat(stat.isDirectory(), "历史目录必须使用普通目录：" + path);
  return true;
}
function sharedDirectory(path: string) {
  const parent = dirname(path);
  return (basename(parent) !== ".pbot" || ordinaryDirectory(parent)) && ordinaryDirectory(path);
}
function ensureDirectory(path: string) {
  if (sharedDirectory(path)) return;
  const first = mkdirSync(path, { recursive: true, mode: 0o700 });
  requireThat(sharedDirectory(path), "无法创建历史目录：" + path);
  if (first) {
    const existing = dirname(resolve(first));
    for (let child = resolve(path); child !== existing && child !== dirname(child); child = dirname(child)) {
      syncDirectory(realpathSync(dirname(child)));
    }
  }
}
function legacyDirectory(root: string, host: HistoryHost) {
  const source = join(root, "." + host), parent = join(source, "pbot"), directory = join(parent, "history");
  return ordinaryDirectory(source) && ordinaryDirectory(parent) && ordinaryDirectory(directory) ? directory : undefined;
}
function removeEmptyDirectory(directory: string) {
  try { rmdirSync(directory); syncDirectory(dirname(directory)); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
const names = (directory: string) => readdirSync(directory).filter(name => name.endsWith(".json"));
const filename = (id: string) => fileId(id) + ".json";
const diagnostic = (path: string, error: unknown) => path + ": " + String(error);
function optional<T>(read: () => T): T | undefined {
  try { return read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function namedRaw(value: unknown, name: string): RawHistory {
  const raw = rawHistory(value);
  requireThat(name === filename(raw.id), "历史文件名与根 ID 不匹配。");
  return raw;
}
const readRaw = (directory: string, name: string) => readJsonFile(directory, "raw/" + name, value => namedRaw(value, name));
const readSummaries = (directory: string, layer: "summary" | "hierarchical", raw: RawHistory) =>
  optional(() => readJsonFile(directory, layer + "/" + filename(raw.id), value => hierarchicalHistory(value, raw)));

type OldFile = { raw: RawHistory; mixed?: HistoryRecord; summaries?: HistorySummary[] };
function oldFile(value: unknown, name: string, privateHost?: HistoryHost): OldFile {
  if (privateHost === undefined && object(value) && !("nodes" in value)) return { raw: namedRaw(value, name) };
  const mixed = legacyHistory(value, privateHost);
  requireThat(name === filename(mixed.id), "历史文件名与根 ID 不匹配。");
  return { ...splitLegacy(mixed), mixed };
}
/** Relocate an already validated file without reserializing it. A separate mount needs an atomic JSON copy instead. */
function linkArchive(directory: string, from: string, to: string) {
  const target = internalPath(directory, to);
  try { linkSync(internalPath(directory, from), target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EXDEV") return false; throw error; }
  syncDirectory(dirname(target)); return true;
}
function retire(directory: string, relative: string) {
  const path = internalPath(directory, relative);
  unlinkSync(path); syncDirectory(dirname(path));
}

export class HistoryFiles {
  #warnings: string[] = [];
  #rawWarnings: string[] = [];
  constructor(readonly directory: string, readonly host: HistoryHost = "pi") { requireThat(isHistoryHost(host), "历史来源无效。"); }
  get warnings(): readonly string[] { return this.#warnings; }
  get rawWarnings(): readonly string[] { return this.#rawWarnings; }

  private readRawWithSummaries(directory: string, name: string, layout: "private" | "shared" | "raw", filterHost?: HistoryHost, excludeHost?: HistoryHost):
    { archive?: HistoryArchive; warning?: string } {
    const path = join(directory, name);
    for (;;) {
      const before = lstatSync(path, { bigint: true });
      const file = readJsonFile(directory, name, (value): OldFile | undefined => {
        if (layout !== "private" && object(value) && isHistoryHost(value.host)) {
          if (filterHost !== undefined && value.host !== filterHost) return undefined;
          if (excludeHost !== undefined && value.host === excludeHost) return undefined;
        }
        return layout === "raw" ? { raw: namedRaw(value, name) } : oldFile(value, name, layout === "private" ? filterHost : undefined);
      });
      if (!file) return {};
      const { raw } = file;
      if (file.summaries) return { archive: { raw, summaries: file.summaries } };
      const layer = layout === "raw" ? "summary" : "hierarchical";
      let summaries: HistorySummary[] | null, warning: string | undefined;
      try { summaries = readSummaries(this.directory, layer, raw)?.summaries ?? []; }
      catch (error) { warning = diagnostic(join(this.directory, layer, name), error); summaries = null; }
      // Peers take no lock. Retry if a native update replaced the raw file between reads.
      const after = lstatSync(path, { bigint: true });
      if (before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) continue;
      return { archive: { raw, summaries }, ...(warning ? { warning } : {}) };
    }
  }

  private scanArchives(legacyRoot: string | undefined, filterHost: HistoryHost | undefined, excludeHost: HistoryHost | undefined): HistoryArchive[] {
    this.#warnings = []; this.#rawWarnings = [];
    const archives = new Map<string, HistoryArchive>();
    const rawWarning = (path: string, error: unknown) => {
      const message = diagnostic(path, error); this.#warnings.push(message); this.#rawWarnings.push(message);
    };
    const scan = (directory: string, layout: "private" | "shared" | "raw", host?: HistoryHost) => {
      for (const name of names(directory)) {
        const path = join(directory, name);
        try {
          const { archive, warning } = this.readRawWithSummaries(directory, name, layout, host, excludeHost);
          if (warning) this.#warnings.push(warning);
          if (archive) archives.set(archive.raw.id, archive);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") rawWarning(path, error); }
      }
    };
    // Read the destinations last: a concurrent migration publishes both files before retiring its source.
    if (legacyRoot) {
      const legacyHosts: HistoryHost[] = filterHost !== undefined
        ? (filterHost === "pi" || filterHost === "dsh" ? [filterHost] : [])
        : (["pi", "dsh"] as const).filter(host => host !== excludeHost);
      for (const host of legacyHosts) {
        try { const directory = legacyDirectory(legacyRoot, host); if (directory) scan(directory, "private", host); }
        catch (error) { rawWarning(join(legacyRoot, "." + host, "pbot/history"), error); }
      }
    }
    try {
      if (sharedDirectory(this.directory)) {
        scan(this.directory, "shared", filterHost);
        const directory = join(this.directory, "raw");
        if (ordinaryDirectory(directory)) scan(directory, "raw", filterHost);
      }
    } catch (error) { rawWarning(this.directory, error); }
    return [...archives.values()];
  }

  list(legacyRoot?: string): HistoryArchive[] {
    return this.scanArchives(legacyRoot, this.host, undefined);
  }

  listAll(legacyRoot?: string, excludeHost?: HistoryHost): HistoryArchive[] {
    return this.scanArchives(legacyRoot, undefined, excludeHost);
  }

  /** O(1) read of a single raw archive and its optional derived summaries by root ID. */
  readArchive(id: string): HistoryArchive | undefined {
    const name = filename(id);
    if (!sharedDirectory(this.directory)) return undefined;
    const rawDir = join(this.directory, "raw");
    if (!ordinaryDirectory(rawDir)) return undefined;
    try {
      const { archive } = this.readRawWithSummaries(rawDir, name, "raw");
      return archive;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private withLock<T>(lockName: string, label: string, operation: () => T): T {
    ensureDirectory(this.directory);
    const lock = join(this.directory, lockName);
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("历史来源写锁被占用：" + label), { code: "PBOT_HISTORY_BUSY" });
      throw error;
    }
    try { return operation(); } finally { rmdirSync(lock); }
  }

  /** The callback is synchronous: no SDK reads or model work can hold this source's write lock. */
  control<T>(operation: () => T): T {
    return this.withLock(".write-" + this.host, this.host, operation);
  }

  /** Derived summary lock shared across hosts; always acquired after any raw source lock if both are needed. */
  controlSummary<T>(operation: () => T): T {
    return this.withLock(".write-summary", "summary", operation);
  }

  private writable(identity: HistoryIdentity, summaryOnly = false) {
    requireThat(isHistoryHost(identity.host) && (summaryOnly || identity.host === this.host), "历史归档只允许所属来源写入。");
    const name = filename(identity.id);
    requireThat(!lstatSync(join(this.directory, name), { throwIfNoEntry: false }), "根 ID 已有旧历史归档：" + name);
    return name;
  }

  saveRaw(raw: RawHistory) {
    const name = this.writable(raw);
    rawHistory(raw); ensureDirectory(this.directory);
    const current = optional(() => readRaw(this.directory, name));
    if (current) {
      matchIdentity(current, raw);
      if (isDeepStrictEqual(current, raw)) return;
    } else {
      for (const layer of ["summary", "hierarchical"]) {
        const directory = join(this.directory, layer);
        if (lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
          requireThat(!lstatSync(join(directory, name), { throwIfNoEntry: false }), "历史根 ID 已有关联的摘要文件：" + name);
        }
      }
      privateDirectory(this.directory, "raw");
    }
    requireThat(writeJsonFile(this.directory, "raw/" + name, raw, rawHistory, !current), "历史根 ID 已被占用：" + name);
  }

  saveSummaries(identity: HistoryIdentity, summaries: readonly HistorySummary[]) {
    const name = this.writable(identity, true);
    requireThat(sharedDirectory(this.directory), "历史原文目录不存在：" + this.directory);
    const raw = readRaw(this.directory, name);
    matchIdentity(raw, identity);
    this.publishSummaries(raw, summaries);
  }

  private publishSummaries(raw: RawHistory, summaries: readonly HistorySummary[], source?: "mixed" | "hierarchical") {
    const { host, id, sessionId } = raw, path = "summary/" + filename(id);
    const validate = (data: unknown) => hierarchicalHistory(data, raw);
    const value = validate({ host, id, sessionId, summaries: summaries.map(summaryData) });
    const previous = readSummaries(this.directory, "summary", raw);
    if (previous) {
      if (isDeepStrictEqual(previous, value)) {
        if (source) syncDirectory(join(this.directory, "summary"));
        return;
      }
      requireThat(!source, "历史摘要迁移冲突，请核对已有文件：" + path);
    } else {
      privateDirectory(this.directory, "summary");
      if (source === "hierarchical" && linkArchive(this.directory, "hierarchical/" + filename(id), path)) return;
    }
    requireThat(writeJsonFile(this.directory, path, value, validate, !previous), "历史摘要文件已被占用：" + path);
  }

  private migrateFile(name: string, privateDir?: string) {
    const readOld = (directory: string, host?: HistoryHost) => readJsonFile(directory, name, value => oldFile(value, name, host));
    const shared = optional(() => readOld(this.directory)), local = privateDir ? readOld(privateDir, this.host) : undefined;
    const source = shared ?? local;
    if (!source) return;
    const { raw } = source;
    if (!local && raw.host !== this.host) return;
    if (shared && local) requireThat(isDeepStrictEqual(shared.raw, local.raw) && (!shared.mixed || isDeepStrictEqual(shared.mixed, local.mixed)),
      "历史归档迁移冲突，请核对新旧文件：" + name);
    const target = optional(() => readRaw(this.directory, name));
    requireThat(!target || isDeepStrictEqual(target, raw), "历史原文迁移冲突，请核对已有文件：" + name);
    const oldLayer = readSummaries(this.directory, "hierarchical", raw), embedded = source.summaries ?? local?.summaries;
    requireThat(!oldLayer || !embedded || isDeepStrictEqual(oldLayer.summaries, embedded), "旧历史摘要不一致：" + name);
    const summaries = embedded ?? oldLayer?.summaries;
    // The raw file makes this pair discoverable. Publish summaries first; never overwrite a migration conflict.
    if (summaries) this.publishSummaries(raw, summaries, oldLayer ? "hierarchical" : "mixed");
    else requireThat(!readSummaries(this.directory, "summary", raw) || target, "历史摘要迁移冲突：" + name);
    if (!target) {
      privateDirectory(this.directory, "raw");
      const path = "raw/" + name;
      if (!shared || shared.mixed || !linkArchive(this.directory, name, path)) {
        requireThat(writeJsonFile(this.directory, path, raw, rawHistory, true), "历史原文迁移冲突：" + name);
      }
    } else syncDirectory(join(this.directory, "raw"));
    syncDirectory(this.directory);
    if (oldLayer) {
      retire(this.directory, "hierarchical/" + name);
      removeEmptyDirectory(join(this.directory, "hierarchical"));
    }
    if (shared) retire(this.directory, name);
    if (privateDir) retire(privateDir, name);
  }

  migrate(root: string) {
    if (this.host !== "pi" && this.host !== "dsh") return;
    const legacy = legacyDirectory(root, this.host);
    const shared = sharedDirectory(this.directory) ? names(this.directory).filter(name => {
      try { return readJsonFile(this.directory, name, value => object(value) && value.host === this.host); }
      catch { return false; } // list reports unreadable roots.
    }) : [];
    if (!legacy && !shared.length) return;
    this.control(() => {
      const directory = legacy && legacyDirectory(root, this.host), errors: string[] = [];
      const migrateFiles = (local: string[]) => {
        const privateNames = new Set(local);
        for (const name of new Set([...local, ...shared])) {
          try { this.migrateFile(name, privateNames.has(name) ? directory : undefined); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code) throw error;
            errors.push(diagnostic(name, error));
          }
        }
      };
      if (directory) {
        requireThat(realpathSync(directory) !== realpathSync(this.directory), "新旧历史目录指向同一位置。");
        const lock = join(directory, ".write"); mkdirSync(lock, { mode: 0o700 });
        try { migrateFiles(names(directory)); } finally { rmdirSync(lock); }
        removeEmptyDirectory(directory); removeEmptyDirectory(dirname(directory));
      } else migrateFiles([]);
      if (errors.length) throw new Error(errors.join("\n"));
    });
  }
}
