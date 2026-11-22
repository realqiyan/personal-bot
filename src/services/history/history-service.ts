import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HistoryArchive, HistoryHost, HistoryIdentity, HistoryLocation, HistoryNode, HistoryRecord, HistorySession, HistorySource, HistorySummarizer } from "../../model/history.js";
import type { HistoryFiles } from "../../storage/history-files.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { historySummaries, historyView, indexHistory, retainHistorySummaries } from "./history-index.js";

export interface HistoryQuery { host?: HistoryHost; query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
type LocatedRecord = { host: HistoryHost; record: HistoryRecord };
type HistoryReader = Pick<HistoryFiles, "host" | "list" | "warnings">;
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

/** Validate the exact target and ordered inputs under the source lock. Only publish the derived file. */
export function commitHistorySummary(files: Pick<HistoryFiles, "control" | "list" | "saveSummaries">, identity: HistoryIdentity,
  expected: HistoryNode, children: readonly HistoryNode[], text: string, signal?: AbortSignal): HistoryRecord | undefined {
  return files.control(() => {
    signal?.throwIfAborted();
    const current = files.list().find(({ raw }) => raw.host === identity.host && raw.id === identity.id && raw.sessionId === identity.sessionId);
    if (!current || current.summaries === null) return;
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

export class HistoryService {
  #records: LocatedRecord[] = [];
  #closed = false;
  #loaded = false;
  #refresh: Promise<void> | undefined;
  #work: Promise<void> | undefined;
  readonly #controller = new AbortController();
  #sourceWarnings: string[] = [];
  #summaryError: string | undefined;
  constructor(readonly root: string, private readonly files: HistoryFiles, private readonly source: HistorySource,
    private readonly otherFiles: readonly HistoryReader[] = [],
    private readonly acpSessions?: () => { ids: Record<HistoryHost, ReadonlySet<string>>; warnings: string[] }) {
    requireThat((source.host === "pi" || source.host === "dsh") && source.host === files.host &&
      new Set([files.host, ...otherFiles.map(value => value.host)]).size === otherFiles.length + 1,
      "历史来源与归档目录不匹配。");
  }
  check() { requireThat(!this.#closed, "历史服务已关闭。"); }
  get warnings() { return [...new Set([...this.#sourceWarnings, ...this.files.warnings, ...this.otherFiles.flatMap(value => value.warnings),
    ...(this.#summaryError ? [this.files.host + " 摘要：" + this.#summaryError] : [])])]; }
  get status() { return { loaded: this.#loaded, organizing: Boolean(this.#work), pending: this.#loaded ? this.#records.filter(value => value.host === this.files.host)
    .reduce((total, value) => total + value.record.nodes.filter(node => node.kind === "summary" && !node.ready).length, 0) : null, warnings: this.warnings }; }
  refresh(location: HistoryLocation, signal?: AbortSignal): Promise<void> {
    this.check(); requireThat(location.host === this.source.host, "历史位置与来源不匹配。");
    // Each caller keeps its own cancellation. A closed page cannot cancel a server-owned refresh.
    const work = (this.#refresh ?? Promise.resolve()).catch(() => {}).then(() => this.load(location, signal));
    this.#refresh = work;
    return work.finally(() => { if (this.#refresh === work) this.#refresh = undefined; });
  }
  private async load(location: HistoryLocation, signal?: AbortSignal) {
    this.check(); signal?.throwIfAborted();
    const warnings: string[] = [], records: LocatedRecord[] = [];
    const warning = (host: HistoryHost, error: unknown) => { this.check(); signal?.throwIfAborted(); warnings.push(host + ": " + String(error)); };
    let known: HistoryArchive[] = [], sessions: HistorySession[] = [];
    try {
      try { this.files.migrate(this.root); } finally { known = this.files.list(this.root); }
      const scanned = await this.source.scan(location, signal, this.acpSessions?.().ids[this.files.host]); sessions = scanned.sessions;
      warnings.push(...scanned.warnings.map(value => this.files.host + ": " + value));
    } catch (error) { warning(this.files.host, error); }
    this.check(); signal?.throwIfAborted();
    // The worker binds the actual backend ID before delivery, possibly during the native scan.
    const excluded = this.acpSessions?.();
    if (excluded) {
      warnings.push(...excluded.warnings);
      sessions = sessions.filter(session => !excluded.ids[this.files.host].has(session.sessionId));
    }
    const visible = ({ raw }: HistoryArchive) => !excluded?.ids[raw.host].has(raw.sessionId);
    try {
      if (sessions.length) {
        const before = new Map(known.map(({ raw }) => [raw.sessionId, raw]));
        known = this.files.control(() => {
          this.check(); signal?.throwIfAborted();
          const current = new Map(this.files.list().map(archive => [archive.raw.sessionId, archive]));
          for (const session of sessions) {
            const previous = current.get(session.sessionId);
            // A damaged raw file may own this session; a damaged summary cannot own a root ID.
            if (!previous && this.files.rawWarnings.length) continue;
            if (!isDeepStrictEqual(before.get(session.sessionId), previous?.raw)) continue;
            const raw = indexHistory(session, previous?.raw, this.files.host);
            if (isDeepStrictEqual(raw, previous?.raw)) continue;
            let summaries = previous ? previous.summaries : [];
            if (previous && summaries?.length) {
              const retained = retainHistorySummaries(previous.raw, raw, summaries);
              // Invalidate first: even an interrupted two-file update cannot attach old text to a corrected exchange.
              if (!isDeepStrictEqual(summaries, retained)) this.files.saveSummaries(previous.raw, retained);
              summaries = retained;
            }
            this.files.saveRaw(raw);
            current.set(session.sessionId, { raw, summaries });
          }
          return [...current.values()];
        });
      }
    } catch (error) { warning(this.files.host, error); }
    records.push(...known.filter(visible).map(view));
    for (const files of this.otherFiles) {
      try { records.push(...files.list(this.root).filter(visible).map(view)); }
      catch (error) { warning(files.host, error); }
    }
    this.check(); signal?.throwIfAborted(); this.#records = records; this.#sourceWarnings = warnings; this.#loaded = true;
  }
  search({ host, query = "", sessionId, from, to, offset = 0, limit = 20 }: HistoryQuery = {}) {
    this.check();
    const needle = query.trim().toLowerCase(), after = from === undefined ? -Infinity : Date.parse(from), before = to === undefined ? Infinity : Date.parse(to);
    requireThat(!Number.isNaN(after) && !Number.isNaN(before) && after <= before, "时间范围无效，请使用 ISO 日期或时间。");
    const matches = this.#records.filter(value => (!host || value.host === host) && (!sessionId || value.record.sessionId === sessionId)).flatMap(value => value.record.nodes
      .filter(node => (needle ? node.kind !== "session" && node.ready && node.text.toLowerCase().includes(needle) : node.kind === "session") &&
        Date.parse(node.to) >= after && Date.parse(node.from) <= before)
      .map(node => {
        const start = Math.max(0, node.text.toLowerCase().indexOf(needle) - 80);
        return { ...brief(value, node), parents: node.parents, snippet: node.text.slice(start, start + 400) };
      })).sort((a, b) => b.to.localeCompare(a.to) || a.id.localeCompare(b.id));
    const result = page(matches, offset, limit);
    return { matches: result.values, total: matches.length, nextOffset: result.nextOffset, warnings: this.warnings };
  }
  private find(id: string, host?: HistoryHost) {
    const values = this.#records.filter(value => (!host || value.host === host) && value.record.nodes.some(node => node.id === id));
    requireThat(values.length, "历史节点不存在，请重新搜索。");
    requireThat(values.length === 1, "历史节点来源不明确，请指定 host。");
    const value = values[0]!, node = value.record.nodes.find(node => node.id === id)!;
    return { value, node };
  }
  read(id: string, offset = 0, limit = 12000, childrenOffset = 0, host?: HistoryHost) {
    this.check();
    const { value, node } = this.find(id, host), lookup = new Map(value.record.nodes.map(node => [node.id, node]));
    requireThat(offset <= node.text.length, "读取位置超出正文。");
    if (offset && /[\uDC00-\uDFFF]/.test(node.text[offset] ?? "")) offset--;
    let end = Math.min(node.text.length, offset + limit);
    if (end < node.text.length && /[\uD800-\uDBFF]/.test(node.text[end - 1] ?? "")) end += end - offset === 1 ? 1 : -1;
    const children = page(node.children, childrenOffset, 20);
    return { ...brief(value, node), text: node.text.slice(offset, end), totalLength: node.text.length,
      nextOffset: end < node.text.length ? end : null,
      parents: node.parents.map(id => brief(value, lookup.get(id)!)), children: children.values.map(id => brief(value, lookup.get(id)!)),
      nextChildrenOffset: children.nextOffset, source: { host: value.host, sessionId: value.record.sessionId, entryIds: node.entryIds }, warnings: this.warnings };
  }
  /** Retain exact inputs only for this call; model work never holds the source write lock. */
  organize(summarize: HistorySummarizer, signal: AbortSignal): Promise<void> {
    this.check();
    const active = AbortSignal.any([signal, this.#controller.signal]);
    const run = async () => {
      for (;;) {
        this.check(); active.throwIfAborted();
        const archives = this.files.list(), excluded = this.acpSessions?.().ids[this.files.host];
        const pending = nextSummary(archives.filter(({ raw }) => !excluded?.has(raw.sessionId)));
        if (!pending) return;
        const { record, node, children } = pending;
        const text = await summarize({ system: readFileSync(join(resourceRoot, "prompts/history-summary.md"), "utf8"), maxTokens: 2048,
          prompt: children.map(child => `[${child.from} — ${child.to}${child.completed ? "" : "；未完成"}]\n${child.text}`).join("\n\n") }, active);
        this.check(); active.throwIfAborted();
        const committed = commitHistorySummary(this.files, record, node, children, text, active);
        if (!committed) return;
        this.#records = this.#records.map(value => value.host === this.files.host && value.record.id === committed.id ? { host: value.host, record: committed } : value);
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
