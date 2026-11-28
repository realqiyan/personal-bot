import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isHistoryIdentifier, requireThat } from "../common/validation.js";
import type { HistoryHost, HistoryLayout, RawHistory, SummaryArtifact } from "../model/history.js";
import { internalPath, readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { fileId, privateDirectory } from "./file-access.js";
import { matchIdentity, rawHistory, summaryArtifact } from "./history-format.js";

const yearPattern = /^\d{4}$/;
const monthPattern = /^(?:0[1-9]|1[0-2])$/;
const monthlyIdPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthlyRelativeJsonPattern = /^(?:\d{4}\/(?:0[1-9]|1[0-2])|unknown)\/[^/]+\.json$/;
const yearlyRelativeJsonPattern = /^(?:\d{4}|unknown)\/[^/]+\.json$/;
export const unknownHistoryBucket = "unknown";
type BucketDepth = "month" | "year";

function ordinaryDirectory(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), "历史目录必须使用普通目录：" + path);
  return true;
}

function ordinaryFile(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat && stat.isFile() && !stat.isSymbolicLink());
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

export function earliestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  let bestMs: number | undefined;
  let bestValue: string | undefined;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (bestMs === undefined || ms < bestMs) {
      bestMs = ms;
      bestValue = value;
    }
  }
  return bestValue;
}

/** Resolve UTC YYYY/MM bucket from an ISO timestamp, falling back to "unknown". */
export function historyBucketFromTimestamp(timestamp?: string): string {
  if (!timestamp) return unknownHistoryBucket;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return unknownHistoryBucket;
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

export function rawHistoryBucket(raw: Pick<RawHistory, "exchanges">): string {
  const earliest = earliestTimestamp(raw.exchanges.map(item => item.from))
    ?? earliestTimestamp(raw.exchanges.map(item => item.to));
  return historyBucketFromTimestamp(earliest);
}

export function summaryArtifactBucket(artifact: Pick<SummaryArtifact, "id" | "dimension" | "from" | "to">): string {
  if (artifact.dimension === "monthly") {
    const match = monthlyIdPattern.exec(artifact.id);
    if (match) return match[1]!;
    const bucket = historyBucketFromTimestamp(artifact.from || artifact.to);
    return bucket === unknownHistoryBucket ? unknownHistoryBucket : bucket.slice(0, 4);
  }
  return historyBucketFromTimestamp(artifact.from || artifact.to);
}

const topLevelJsonNames = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map(entry => entry.name)
    .sort();

function bucketDirs(directory: string, depth: BucketDepth): string[] {
  if (!ordinaryDirectory(directory)) return [];
  const buckets: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const years = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && yearPattern.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));
  if (depth === "year") {
    buckets.push(...years);
  } else {
    for (const year of years) {
      const yearDir = join(directory, year);
      const months = readdirSync(yearDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && monthPattern.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a));
      for (const month of months) buckets.push(`${year}/${month}`);
    }
  }
  if (entries.some(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name === unknownHistoryBucket)) {
    buckets.push(unknownHistoryBucket);
  }
  return buckets;
}

function listLayoutJsonFiles(directory: string, layout: HistoryLayout, depth: BucketDepth = "month"): string[] {
  if (!ordinaryDirectory(directory)) return [];
  if (layout === "flat") return topLevelJsonNames(directory);
  const results: string[] = [];
  for (const bucket of bucketDirs(directory, depth)) {
    const dir = join(directory, bucket);
    for (const name of topLevelJsonNames(dir)) {
      results.push(`${bucket}/${name}`);
    }
  }
  return results;
}

function locateLayoutFile(directory: string, name: string, layout: HistoryLayout, depth: BucketDepth = "month"): string | undefined {
  if (!ordinaryDirectory(directory)) return undefined;
  if (layout === "flat") {
    return ordinaryFile(join(directory, name)) ? name : undefined;
  }
  for (const bucket of bucketDirs(directory, depth)) {
    if (ordinaryFile(join(directory, bucket, name))) return `${bucket}/${name}`;
  }
  return undefined;
}

const filename = (id: string) => fileId(id) + ".json";
const diagnostic = (path: string, error: unknown) => path + ": " + String(error);

function optional<T>(read: () => T): T | undefined {
  try { return read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function namedRaw(value: unknown, relPath: string): RawHistory {
  const raw = rawHistory(value);
  requireThat(basename(relPath) === filename(raw.id), "历史文件名与根 ID 不匹配。");
  return raw;
}

function namedSummary(value: unknown, relPath: string, dimension: string): SummaryArtifact {
  const artifact = summaryArtifact(value, dimension);
  requireThat(basename(relPath) === filename(artifact.id), "历史摘要文件名与 ID 不匹配。");
  return artifact;
}

/**
 * Use ripgrep when available to pre-filter candidate JSON files containing a literal query.
 * Queries containing JSON-escaped characters fall back to direct Node reading to avoid false negatives.
 */
function canPrefilterWithRg(query: string): boolean {
  return query.length > 0 && !/["\\\n\r\t]/.test(query);
}

export function findCandidateJsonFiles(
  directory: string,
  query: string,
  layout: HistoryLayout = "monthly",
  depth: BucketDepth = "month",
): string[] {
  if (!ordinaryDirectory(directory)) return [];
  const trimmed = query.trim();
  if (!trimmed) return listLayoutJsonFiles(directory, layout, depth);

  const relativePattern = depth === "year" ? yearlyRelativeJsonPattern : monthlyRelativeJsonPattern;

  if (canPrefilterWithRg(trimmed)) {
    const args = [
      "--ignore-case",
      "--fixed-strings",
      "--files-with-matches",
      "--glob", "*.json",
      "--no-ignore",
      "--hidden",
      ...(layout === "flat" ? ["--max-depth", "1"] : []),
      "--",
      trimmed,
      directory,
    ];
    const result = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (!result.error && (result.status === 0 || result.status === 1)) {
      if (result.status === 1) return [];
      const base = realpathSync(directory);
      const matched: string[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        const rel = relative(base, resolve(trimmedLine)).replaceAll("\\", "/");
        if (layout === "flat") {
          if (!rel.includes("/") && rel.endsWith(".json")) matched.push(rel);
        } else if (relativePattern.test(rel)) {
          matched.push(rel);
        }
      }
      return matched;
    }
  }

  // Fallback: direct case-insensitive file scan via Node built-ins.
  const needle = trimmed.toLowerCase();
  const matched: string[] = [];
  for (const rel of listLayoutJsonFiles(directory, layout, depth)) {
    try {
      const content = readFileSync(join(directory, rel), "utf8");
      if (content.toLowerCase().includes(needle)) matched.push(rel);
    } catch { /* Individual unreadable files are reported during JSON parse if needed. */ }
  }
  return matched;
}

export interface FlatHistoryInventory {
  rawCount: number;
  summaryCount: number;
  total: number;
  message?: string;
}

export class HistoryFiles {
  #warnings: string[] = [];
  #rawWarnings: string[] = [];

  constructor(
    readonly directory: string,
    readonly host: HistoryHost = "pi",
    readonly layout: HistoryLayout = "monthly",
  ) {
    requireThat(isHistoryIdentifier(host), "历史来源无效。");
  }

  get warnings(): readonly string[] { return this.#warnings; }
  get rawWarnings(): readonly string[] { return this.#rawWarnings; }

  get rawDirectory(): string { return join(this.directory, "raw"); }
  get summariesDirectory(): string { return join(this.directory, "summaries"); }
  summaryDirectory(dimension: string): string {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    return join(this.summariesDirectory, dimension);
  }

  private withLock<T>(lockName: string, label: string, operation: () => T): T {
    ensureDirectory(this.directory);
    const lock = join(this.directory, lockName);
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw Object.assign(new Error("历史写锁被占用：" + label), { code: "PBOT_HISTORY_BUSY" });
      }
      throw error;
    }
    try { return operation(); } finally { rmdirSync(lock); }
  }

  /** Synchronous host write lock for raw history files. */
  control<T>(operation: () => T): T {
    return this.withLock(".write-" + this.host, this.host, operation);
  }

  /** Synchronous dimension write lock for derived summary files. */
  controlSummary<T>(dimension: string, operation: () => T): T {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    return this.withLock(".write-summary-" + dimension, "summary:" + dimension, operation);
  }

  /** Synchronous migration lock for explicit layout migration. */
  controlMigration<T>(operation: () => T): T {
    return this.withLock(".write-migrate", "migrate", operation);
  }

  migrationNotice(): string | undefined {
    return this.layout === "monthly" ? this.detectFlatFiles().message : undefined;
  }

  /** Detect unmigrated top-level flat JSON files when running under monthly layout. */
  detectFlatFiles(): FlatHistoryInventory {
    if (!sharedDirectory(this.directory)) return { rawCount: 0, summaryCount: 0, total: 0 };
    const rawCount = ordinaryDirectory(this.rawDirectory) ? topLevelJsonNames(this.rawDirectory).length : 0;
    let summaryCount = 0;
    for (const dim of this.listDimensions()) {
      const dir = this.summaryDirectory(dim);
      if (ordinaryDirectory(dir)) summaryCount += topLevelJsonNames(dir).length;
    }
    const total = rawCount + summaryCount;
    if (total === 0) return { rawCount: 0, summaryCount: 0, total: 0 };
    return {
      rawCount,
      summaryCount,
      total,
      message:
        `检测到 ${total} 个未迁移的平铺历史文件（raw ${rawCount}，summaries ${summaryCount}）；当前为年月目录布局（history.layout: monthly），未迁移文件不会被读取。` +
        `请运行 /pbot history migrate 整理到 YYYY/MM/ 目录，或在 .pbot/config.json 中设置 "history": { "layout": "flat" } 切回平铺布局。`,
    };
  }

  listFlatRawFiles(): string[] {
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.rawDirectory)) return [];
    return topLevelJsonNames(this.rawDirectory);
  }

  listFlatSummaryFiles(dimension: string): string[] {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    const dir = this.summaryDirectory(dimension);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory) || !ordinaryDirectory(dir)) return [];
    return topLevelJsonNames(dir);
  }

  readFlatRawFile(name: string): RawHistory {
    return readJsonFile(this.directory, "raw/" + name, value => namedRaw(value, name));
  }

  readFlatSummaryFile(dimension: string, name: string): SummaryArtifact {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    return readJsonFile(this.directory, `summaries/${dimension}/${name}`, value => namedSummary(value, name, dimension));
  }

  /** Atomically move a file within .pbot/history/ without ever overwriting an existing destination. */
  moveHistoryFile(fromRelative: string, toRelative: string, dryRun = false): "moved" | "conflict" {
    const src = internalPath(this.directory, fromRelative);
    if (dryRun) {
      const target = internalPath(this.directory, toRelative, true);
      return ordinaryFile(target) ? "conflict" : "moved";
    }
    const dstParentRel = dirname(toRelative);
    if (dstParentRel && dstParentRel !== ".") {
      privateDirectory(this.directory, dstParentRel);
    }
    const dst = internalPath(this.directory, toRelative);
    try {
      linkSync(src, dst);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "conflict";
      throw error;
    }
    syncDirectory(dirname(dst));
    unlinkSync(src);
    syncDirectory(dirname(src));
    return "moved";
  }

  listRaw(filterHost?: HistoryHost, onlyFiles?: readonly string[]): RawHistory[] {
    this.#warnings = [];
    this.#rawWarnings = [];
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.rawDirectory)) return [];
    const files = onlyFiles ?? listLayoutJsonFiles(this.rawDirectory, this.layout);
    const results: RawHistory[] = [];
    for (const rel of files) {
      const path = join(this.rawDirectory, rel);
      try {
        const raw = readJsonFile(this.directory, "raw/" + rel, value => namedRaw(value, rel));
        if (filterHost !== undefined && raw.host !== filterHost) continue;
        results.push(raw);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          const message = diagnostic(path, error);
          this.#warnings.push(message);
          this.#rawWarnings.push(message);
        }
      }
    }
    return results;
  }

  readRaw(id: string): RawHistory | undefined {
    const name = filename(id);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.rawDirectory)) return undefined;
    const rel = locateLayoutFile(this.rawDirectory, name, this.layout);
    if (!rel) return undefined;
    return optional(() => readJsonFile(this.directory, "raw/" + rel, value => namedRaw(value, rel)));
  }

  saveRaw(raw: RawHistory) {
    requireThat(isHistoryIdentifier(raw.host) && raw.host === this.host, "历史归档只允许所属来源写入。");
    rawHistory(raw);
    ensureDirectory(this.directory);
    const name = filename(raw.id);
    const existingRel = ordinaryDirectory(this.rawDirectory)
      ? locateLayoutFile(this.rawDirectory, name, this.layout)
      : undefined;
    const bucket = this.layout === "monthly" ? rawHistoryBucket(raw) : undefined;
    const rel = existingRel ?? (bucket ? `${bucket}/${name}` : name);
    const current = optional(() => readJsonFile(this.directory, "raw/" + rel, value => namedRaw(value, rel)));
    if (current) {
      matchIdentity(current, raw);
      if (isDeepStrictEqual(current, raw)) return;
    } else {
      privateDirectory(this.directory, bucket ? `raw/${bucket}` : "raw");
    }
    requireThat(writeJsonFile(this.directory, "raw/" + rel, raw, rawHistory, !current), "历史根 ID 已被占用：" + rel);
  }

  listDimensions(): string[] {
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory)) return [];
    const entries = readdirSync(this.summariesDirectory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isHistoryIdentifier(entry.name))
      .map(entry => entry.name)
      .sort();
  }

  private summaryBucketDepth(dimension: string): BucketDepth {
    return dimension === "monthly" ? "year" : "month";
  }

  listSummaries(dimension: string, onlyFiles?: readonly string[]): SummaryArtifact[] {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    const dir = this.summaryDirectory(dimension);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory) || !ordinaryDirectory(dir)) return [];
    const files = onlyFiles ?? listLayoutJsonFiles(dir, this.layout, this.summaryBucketDepth(dimension));
    const results: SummaryArtifact[] = [];
    for (const rel of files) {
      const path = join(dir, rel);
      try {
        results.push(readJsonFile(this.directory, `summaries/${dimension}/${rel}`, value => namedSummary(value, rel, dimension)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.#warnings.push(diagnostic(path, error));
        }
      }
    }
    return results;
  }

  readSummary(dimension: string, id: string): SummaryArtifact | undefined {
    requireThat(isHistoryIdentifier(dimension), "历史摘要维度无效：" + dimension);
    const dir = this.summaryDirectory(dimension);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory) || !ordinaryDirectory(dir)) return undefined;
    const name = filename(id);
    const rel = locateLayoutFile(dir, name, this.layout, this.summaryBucketDepth(dimension));
    if (!rel) return undefined;
    return optional(() => readJsonFile(this.directory, `summaries/${dimension}/${rel}`, value => namedSummary(value, rel, dimension)));
  }

  saveSummary(artifact: SummaryArtifact) {
    summaryArtifact(artifact);
    ensureDirectory(this.directory);
    const name = filename(artifact.id);
    const dir = this.summaryDirectory(artifact.dimension);
    const depth = this.summaryBucketDepth(artifact.dimension);
    const existingRel = ordinaryDirectory(this.summariesDirectory) && ordinaryDirectory(dir)
      ? locateLayoutFile(dir, name, this.layout, depth)
      : undefined;
    const bucket = this.layout === "monthly" ? summaryArtifactBucket(artifact) : undefined;
    const rel = existingRel ?? (bucket ? `${bucket}/${name}` : name);
    const relativePath = `summaries/${artifact.dimension}/${rel}`;
    privateDirectory(this.directory, dirname(relativePath));
    const current = optional(() => readJsonFile(this.directory, relativePath, value => namedSummary(value, rel, artifact.dimension)));
    if (current && isDeepStrictEqual(current, artifact)) return;
    requireThat(
      writeJsonFile(this.directory, relativePath, artifact, value => summaryArtifact(value, artifact.dimension), !current),
      "历史摘要文件已被占用：" + relativePath,
    );
  }

  /** Isolated read-only candidate search across raw/ and summaries/<dimension>/. */
  searchCandidateRaw(query: string): RawHistory[] {
    const names = findCandidateJsonFiles(this.rawDirectory, query, this.layout, "month");
    return this.listRaw(undefined, names);
  }

  searchCandidateSummaries(dimension: string, query: string): SummaryArtifact[] {
    const dir = this.summaryDirectory(dimension);
    const names = findCandidateJsonFiles(dir, query, this.layout, this.summaryBucketDepth(dimension));
    return this.listSummaries(dimension, names);
  }
}
