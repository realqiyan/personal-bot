import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireThat } from "../common/validation.js";
import type { HistoryHost, RawHistory, SummaryArtifact } from "../model/history.js";
import { readJsonFile, syncDirectory, writeJsonFile } from "./atomic-json.js";
import { fileId, privateDirectory } from "./file-access.js";
import { isHistoryHost, isSummaryDimension, matchIdentity, rawHistory, summaryArtifact } from "./history-format.js";

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

const jsonNames = (directory: string) => readdirSync(directory).filter(name => name.endsWith(".json"));
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

function namedSummary(value: unknown, name: string, dimension: string): SummaryArtifact {
  const artifact = summaryArtifact(value, dimension);
  requireThat(name === filename(artifact.id), "历史摘要文件名与 ID 不匹配。");
  return artifact;
}

/**
 * Use ripgrep when available to pre-filter candidate JSON files containing a literal query.
 * Queries containing JSON-escaped characters fall back to direct Node reading to avoid false negatives.
 */
function canPrefilterWithRg(query: string): boolean {
  return query.length > 0 && !/["\\\n\r\t]/.test(query);
}

export function findCandidateJsonFiles(directory: string, query: string): string[] {
  if (!ordinaryDirectory(directory)) return [];
  const trimmed = query.trim();
  if (!trimmed) return jsonNames(directory);

  if (canPrefilterWithRg(trimmed)) {
    const result = spawnSync(
      "rg",
      ["--ignore-case", "--fixed-strings", "--files-with-matches", "--glob", "*.json", "--no-ignore", "--hidden", "--", trimmed, directory],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    if (!result.error && (result.status === 0 || result.status === 1)) {
      if (result.status === 1) return [];
      return result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => basename(line))
        .filter(name => name.endsWith(".json"));
    }
  }

  // Fallback: direct case-insensitive file scan via Node built-ins.
  const needle = trimmed.toLowerCase();
  const matched: string[] = [];
  for (const name of jsonNames(directory)) {
    try {
      const content = readFileSync(join(directory, name), "utf8");
      if (content.toLowerCase().includes(needle)) matched.push(name);
    } catch { /* Individual unreadable files are reported during JSON parse if needed. */ }
  }
  return matched;
}

export class HistoryFiles {
  #warnings: string[] = [];
  #rawWarnings: string[] = [];

  constructor(readonly directory: string, readonly host: HistoryHost = "pi") {
    requireThat(isHistoryHost(host), "历史来源无效。");
  }

  get warnings(): readonly string[] { return this.#warnings; }
  get rawWarnings(): readonly string[] { return this.#rawWarnings; }

  get rawDirectory(): string { return join(this.directory, "raw"); }
  get summariesDirectory(): string { return join(this.directory, "summaries"); }
  summaryDirectory(dimension: string): string {
    requireThat(isSummaryDimension(dimension), "历史摘要维度无效：" + dimension);
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
    requireThat(isSummaryDimension(dimension), "历史摘要维度无效：" + dimension);
    return this.withLock(".write-summary-" + dimension, "summary:" + dimension, operation);
  }

  listRaw(filterHost?: HistoryHost, onlyFiles?: readonly string[]): RawHistory[] {
    this.#warnings = [];
    this.#rawWarnings = [];
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.rawDirectory)) return [];
    const files = onlyFiles ?? jsonNames(this.rawDirectory);
    const results: RawHistory[] = [];
    for (const name of files) {
      const path = join(this.rawDirectory, name);
      try {
        const raw = readJsonFile(this.directory, "raw/" + name, value => namedRaw(value, name));
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
    return optional(() => readJsonFile(this.directory, "raw/" + name, value => namedRaw(value, name)));
  }

  saveRaw(raw: RawHistory) {
    requireThat(isHistoryHost(raw.host) && raw.host === this.host, "历史归档只允许所属来源写入。");
    rawHistory(raw);
    ensureDirectory(this.directory);
    const name = filename(raw.id);
    const current = optional(() => readJsonFile(this.directory, "raw/" + name, value => namedRaw(value, name)));
    if (current) {
      matchIdentity(current, raw);
      if (isDeepStrictEqual(current, raw)) return;
    } else {
      privateDirectory(this.directory, "raw");
    }
    requireThat(writeJsonFile(this.directory, "raw/" + name, raw, rawHistory, !current), "历史根 ID 已被占用：" + name);
  }

  listDimensions(): string[] {
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory)) return [];
    const entries = readdirSync(this.summariesDirectory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && isSummaryDimension(entry.name))
      .map(entry => entry.name)
      .sort();
  }

  listSummaries(dimension: string, onlyFiles?: readonly string[]): SummaryArtifact[] {
    requireThat(isSummaryDimension(dimension), "历史摘要维度无效：" + dimension);
    const dir = this.summaryDirectory(dimension);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory) || !ordinaryDirectory(dir)) return [];
    const files = onlyFiles ?? jsonNames(dir);
    const results: SummaryArtifact[] = [];
    for (const name of files) {
      const path = join(dir, name);
      try {
        results.push(readJsonFile(this.directory, `summaries/${dimension}/${name}`, value => namedSummary(value, name, dimension)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.#warnings.push(diagnostic(path, error));
        }
      }
    }
    return results;
  }

  readSummary(dimension: string, id: string): SummaryArtifact | undefined {
    requireThat(isSummaryDimension(dimension), "历史摘要维度无效：" + dimension);
    const dir = this.summaryDirectory(dimension);
    if (!sharedDirectory(this.directory) || !ordinaryDirectory(this.summariesDirectory) || !ordinaryDirectory(dir)) return undefined;
    const name = filename(id);
    return optional(() => readJsonFile(this.directory, `summaries/${dimension}/${name}`, value => namedSummary(value, name, dimension)));
  }

  saveSummary(artifact: SummaryArtifact) {
    summaryArtifact(artifact);
    ensureDirectory(this.directory);
    privateDirectory(this.directory, "summaries");
    privateDirectory(this.summariesDirectory, artifact.dimension);
    const name = filename(artifact.id);
    const relative = `summaries/${artifact.dimension}/${name}`;
    const current = optional(() => readJsonFile(this.directory, relative, value => namedSummary(value, name, artifact.dimension)));
    if (current && isDeepStrictEqual(current, artifact)) return;
    requireThat(
      writeJsonFile(this.directory, relative, artifact, value => summaryArtifact(value, artifact.dimension), !current),
      "历史摘要文件已被占用：" + relative,
    );
  }

  /** Isolated read-only candidate search across raw/ and summaries/<dimension>/. */
  searchCandidateRaw(query: string): RawHistory[] {
    const names = findCandidateJsonFiles(this.rawDirectory, query);
    return this.listRaw(undefined, names);
  }

  searchCandidateSummaries(dimension: string, query: string): SummaryArtifact[] {
    const dir = this.summaryDirectory(dimension);
    const names = findCandidateJsonFiles(dir, query);
    return this.listSummaries(dimension, names);
  }
}
