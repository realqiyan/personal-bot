import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HistoryArchive, HistoryHost, HistoryIdentity, HistoryNode, HistoryRecord, HistorySummarizer } from "../../model/history.js";
import type { HistoryFiles } from "../../storage/history-files.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { historySummaries, historyView } from "./history-index.js";

export interface HistoryQuery { host?: HistoryHost; query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
type LocatedRecord = { host: HistoryHost; record: HistoryRecord };
const page = <T>(values: T[], offset: number, limit: number) => ({ values: values.slice(offset, offset + limit),
  nextOffset: offset + limit < values.length ? offset + limit : null });
const brief = ({ host, record }: LocatedRecord, node: HistoryNode) => ({ host, id: node.id, kind: node.kind, sessionId: record.sessionId,
  name: record.name, preview: node.text.replace(/\s+/g, " ").slice(0, 100), from: node.from, to: node.to, ready: node.ready, completed: node.completed });
const view = ({ raw, summaries }: HistoryArchive): LocatedRecord => ({ host: raw.host, record: historyView(raw, summaries) });
const summarySource = (node: HistoryNode) => [node.id, node.kind, node.level, node.entryIds, node.children, node.text, node.from, node.to, node.completed, node.ready];

function nextSummary(archives: HistoryArchive[]) {
  for (const { raw, summaries } of archives) {
    if (summaries === null) continue;
    const record = historyView(raw, summaries), lookup = new Map(record.nodes.map(node => [node.id, node]));
    const node = record.nodes.find(node => node.kind === "summary" && !node.ready && node.children.every(id => lookup.get(id)!.ready));
    if (node) return { record, node, children: node.children.map(id => lookup.get(id)!) };
  }
}

/** Validate the exact target and ordered inputs under the summary lock. Only publish the derived file. */
export function commitHistorySummary(
  files: Pick<HistoryFiles, "control" | "list" | "saveSummaries"> & Partial<Pick<HistoryFiles, "controlSummary" | "readArchive">>,
  identity: HistoryIdentity,
  expected: HistoryNode,
  children: readonly HistoryNode[],
  text: string,
  signal?: AbortSignal,
): HistoryRecord | undefined {
  const lock = files.controlSummary ? files.controlSummary.bind(files) : files.control.bind(files);
  return lock(() => {
    signal?.throwIfAborted();
    const current = files.readArchive
      ? files.readArchive(identity.id)
      : files.list().find(({ raw }) => raw.host === identity.host && raw.id === identity.id && raw.sessionId === identity.sessionId);
    if (!current || current.summaries === null ||
      current.raw.host !== identity.host || current.raw.id !== identity.id || current.raw.sessionId !== identity.sessionId) return;
    const record = historyView(current.raw, current.summaries), lookup = new Map(record.nodes.map(node => [node.id, node]));
    const node = lookup.get(expected.id);
    if (!node || node.kind !== "summary" || node.ready || !isDeepStrictEqual(summarySource(node), summarySource(expected)) ||
      !isDeepStrictEqual(node.children, children.map(child => child.id))) return;
    for (const child of children) {
      const input = lookup.get(child.id);
      if (!input?.ready || !isDeepStrictEqual(summarySource(input), summarySource(child))) return;
    }
    requireThat(text.trim(), "历史摘要为空。");
    node.text = text.trim(); node.ready = true;
    files.saveSummaries(current.raw, historySummaries(record));
    return record;
  });
}

export function searchLocatedRecords(records: readonly LocatedRecord[], warnings: readonly string[],
  { host, query = "", sessionId, from, to, offset = 0, limit = 20 }: HistoryQuery = {}) {
  const needle = query.trim().toLowerCase(), after = from === undefined ? -Infinity : Date.parse(from), before = to === undefined ? Infinity : Date.parse(to);
  requireThat(!Number.isNaN(after) && !Number.isNaN(before) && after <= before, "时间范围无效，请使用 ISO 日期或时间。");
  const matches = records.filter(value => (!host || value.host === host) && (!sessionId || value.record.sessionId === sessionId)).flatMap(value => value.record.nodes
    .filter(node => (needle ? node.kind !== "session" && node.ready && node.text.toLowerCase().includes(needle) : node.kind === "session") &&
      Date.parse(node.to) >= after && Date.parse(node.from) <= before)
    .map(node => {
      const start = Math.max(0, node.text.toLowerCase().indexOf(needle) - 80);
      return { ...brief(value, node), parents: node.parents, snippet: node.text.slice(start, start + 400) };
    })).sort((a, b) => b.to.localeCompare(a.to) || a.id.localeCompare(b.id));
  const result = page(matches, offset, limit);
  return { matches: result.values, total: matches.length, nextOffset: result.nextOffset, warnings: [...warnings] };
}

export function readLocatedRecords(records: readonly LocatedRecord[], warnings: readonly string[],
  id: string, offset = 0, limit = 12000, childrenOffset = 0, host?: HistoryHost) {
  const values = records.filter(value => (!host || value.host === host) && value.record.nodes.some(node => node.id === id));
  requireThat(values.length, "历史节点不存在，请重新搜索。");
  requireThat(values.length === 1, "历史节点来源不明确，请指定 host。");
  const value = values[0]!, node = value.record.nodes.find(item => item.id === id)!;
  const lookup = new Map(value.record.nodes.map(item => [item.id, item]));
  requireThat(offset <= node.text.length, "读取位置超出正文。");
  if (offset && /[\uDC00-\uDFFF]/.test(node.text[offset] ?? "")) offset--;
  let end = Math.min(node.text.length, offset + limit);
  if (end < node.text.length && /[\uD800-\uDBFF]/.test(node.text[end - 1] ?? "")) end += end - offset === 1 ? 1 : -1;
  const children = page(node.children, childrenOffset, 20);
  return { ...brief(value, node), text: node.text.slice(offset, end), totalLength: node.text.length,
    nextOffset: end < node.text.length ? end : null,
    parents: node.parents.map(parentId => brief(value, lookup.get(parentId)!)), children: children.values.map(childId => brief(value, lookup.get(childId)!)),
    nextChildrenOffset: children.nextOffset, source: { host: value.host, sessionId: value.record.sessionId, entryIds: node.entryIds }, warnings: [...warnings] };
}

/** Read-only query over all persisted workspace archives in .pbot/history/. */
export function queryWorkspaceHistory(files: Pick<HistoryFiles, "listAll" | "warnings">) {
  const records = files.listAll().map(view);
  const warnings = [...new Set(files.warnings)];
  return {
    search: (query: HistoryQuery = {}) => searchLocatedRecords(records, warnings, query),
    read: (id: string, offset = 0, limit = 12000, childrenOffset = 0, host?: HistoryHost) =>
      readLocatedRecords(records, warnings, id, offset, limit, childrenOffset, host),
  };
}

/** Workspace history query & summary service backed solely by .pbot/history/. */
export class HistoryService {
  #records: LocatedRecord[] = [];
  #closed = false;
  #loaded = false;
  #refresh: Promise<void> | undefined;
  #work: Promise<void> | undefined;
  readonly #controller = new AbortController();
  #loadWarnings: string[] = [];
  #summaryError: string | undefined;

  constructor(readonly root: string, private readonly files: HistoryFiles) {}

  check() { requireThat(!this.#closed, "历史服务已关闭。"); }
  get warnings() {
    return [...new Set([
      ...this.#loadWarnings,
      ...this.files.warnings,
      ...(this.#summaryError ? [this.files.host + " 摘要：" + this.#summaryError] : []),
    ])];
  }
  get status() {
    return {
      loaded: this.#loaded,
      organizing: Boolean(this.#work),
      pending: this.#loaded
        ? this.#records.reduce((total, value) => total + value.record.nodes.filter(node => node.kind === "summary" && !node.ready).length, 0)
        : null,
      warnings: this.warnings,
    };
  }

  refresh(signal?: AbortSignal): Promise<void> {
    this.check();
    // Each caller keeps its own cancellation. A closed page cannot cancel a server-owned refresh.
    const work = (this.#refresh ?? Promise.resolve()).catch(() => {}).then(() => this.load(signal));
    this.#refresh = work;
    return work.finally(() => { if (this.#refresh === work) this.#refresh = undefined; });
  }

  private async load(signal?: AbortSignal) {
    this.check(); signal?.throwIfAborted();
    const warnings: string[] = [];
    let records: LocatedRecord[] = [];
    try {
      records = this.files.listAll().map(view);
    } catch (error) {
      this.check(); signal?.throwIfAborted();
      warnings.push(String(error));
    }
    this.check(); signal?.throwIfAborted();
    this.#records = records;
    this.#loadWarnings = warnings;
    this.#loaded = true;
  }

  search(query: HistoryQuery = {}) {
    this.check();
    return searchLocatedRecords(this.#records, this.warnings, query);
  }

  read(id: string, offset = 0, limit = 12000, childrenOffset = 0, host?: HistoryHost) {
    this.check();
    return readLocatedRecords(this.#records, this.warnings, id, offset, limit, childrenOffset, host);
  }

  /** Retain exact inputs only for this call; model work never holds the summary write lock. */
  organize(summarize: HistorySummarizer, signal: AbortSignal): Promise<void> {
    this.check();
    const active = AbortSignal.any([signal, this.#controller.signal]);
    const run = async () => {
      const system = readFileSync(join(resourceRoot, "prompts/history-summary.md"), "utf8");
      for (;;) {
        this.check(); active.throwIfAborted();
        const archives = this.files.listAll();
        const pending = nextSummary(archives);
        if (!pending) return;
        const { record, node, children } = pending;
        const text = await summarize({ system, maxTokens: 2048,
          prompt: children.map(child => `[${child.from} — ${child.to}${child.completed ? "" : "；未完成"}]\n${child.text}`).join("\n\n") }, active);
        this.check(); active.throwIfAborted();
        const committed = commitHistorySummary(this.files, record, node, children, text, active);
        if (!committed) return;
        this.#records = this.#records.map(value => value.host === committed.host && value.record.id === committed.id ? { host: value.host, record: committed } : value);
      }
    };
    const work = (this.#work ?? Promise.resolve()).catch(() => {}).then(run).then(() => { this.#summaryError = undefined; }).catch(error => {
      if (!active.aborted && !this.#closed) this.#summaryError = String(error);
      throw error;
    });
    this.#work = work;
    return work.finally(() => { if (this.#work === work) this.#work = undefined; });
  }

  async close() {
    this.#closed = true; this.#controller.abort();
    await Promise.allSettled([this.#work, this.#refresh]); this.#records = []; this.#loaded = false;
  }
}
