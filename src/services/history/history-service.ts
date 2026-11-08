import { randomUUID } from "node:crypto";
import type { HistoryExchange, HistoryHost, HistoryLocation, HistoryNode, HistoryRecord, HistorySession, HistorySource, HistorySummarizer } from "../../model/history.js";
import type { HistoryFiles } from "../../storage/history-files.js";
import { requireThat } from "../../common/validation.js";

/** Shared prefixes reuse nodes; only consecutive exchanges on one native branch can merge. */
export function indexHistory(session: HistorySession, previous?: HistoryRecord, host: HistoryHost = previous?.host ?? "pi"): HistoryRecord {
  const id = previous?.id ?? (host === "dsh" ? "dsh-" : "") + randomUUID(), nodes = new Map<string, HistoryNode>();
  const old = new Map(previous?.nodes.map(node => [node.id, node])), changed = new Set<string>();
  const add = (value: HistoryExchange, level: number, children: string[] = []): HistoryNode => {
    const key = `${id}:${level}:${value.entryIds.at(-1)}`, found = nodes.get(key);
    if (found) return found;
    const before = old.get(key), same = before && JSON.stringify(before.children) === JSON.stringify(children) &&
      (level ? children.every(child => !changed.has(child)) : before.text === value.text && before.completed === value.completed);
    const node: HistoryNode = { ...value, id: key, kind: level ? "summary" : "exchange", level, children, parents: [],
      text: level ? same ? before.text : "" : value.text, ready: level ? Boolean(same && before.ready) : true };
    if (!same) changed.add(key);
    nodes.set(key, node); return node;
  };
  const roots = new Set<string>();
  for (const branch of session.branches) {
    let layer = branch.map(exchange => add(exchange, 0)), level = 1;
    while (layer.length >= 4) {
      const count = Math.floor(layer.length / 4) * 4, next: HistoryNode[] = [];
      layer.slice(count).forEach(node => roots.add(node.id));
      for (let i = 0; i < count; i += 4) {
        const children = layer.slice(i, i + 4), first = children[0]!, last = children.at(-1)!;
        next.push(add({ entryIds: [first.entryIds[0]!, last.entryIds.at(-1)!], text: "", from: first.from, to: last.to,
          completed: children.every(node => node.completed) }, level, children.map(node => node.id)));
      }
      layer = next; level++;
    }
    layer.forEach(node => roots.add(node.id));
  }
  const dates = [...nodes.values()].flatMap(node => [node.from, node.to]).sort();
  nodes.set(id, { id, kind: "session", level: -1, entryIds: [], text: session.name, ready: true, completed: [...nodes.values()].every(node => node.completed),
    from: dates[0] ?? "", to: dates.at(-1) ?? "", parents: [],
    children: [...roots].sort((a, b) => nodes.get(a)!.from.localeCompare(nodes.get(b)!.from)) });
  for (const node of nodes.values()) for (const child of node.children) nodes.get(child)!.parents.push(node.id);
  return { host, id, sessionId: session.sessionId, name: session.name, nodes: [...nodes.values()] };
}

export interface HistoryQuery { host?: HistoryHost; query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
type LocatedRecord = { host: HistoryHost; record: HistoryRecord };
const page = <T>(values: T[], offset: number, limit: number) => ({ values: values.slice(offset, offset + limit),
  nextOffset: offset + limit < values.length ? offset + limit : null });
const brief = ({ host, record }: LocatedRecord, node: HistoryNode) => ({ host, id: node.id, kind: node.kind, sessionId: record.sessionId,
  name: record.name, preview: node.text.replace(/\s+/g, " ").slice(0, 100), from: node.from, to: node.to, ready: node.ready, completed: node.completed });
const rawSource = (record?: HistoryRecord) => record && JSON.stringify({ name: record.name,
  exchanges: record.nodes.filter(node => node.kind === "exchange").map(node => [node.id, node.entryIds, node.text, node.from, node.to, node.completed]) });
const summarySource = (node: HistoryNode) => [node.id, node.entryIds, node.children, node.text, node.from, node.to, node.completed, node.ready];

/** Validate the exact inputs again under the source lock; another writer's ready summary wins. */
export function completeHistorySummary(record: HistoryRecord, id: string, children: HistoryNode[], text: string) {
  const node = record.nodes.find(value => value.id === id);
  if (!node || node.kind !== "summary" || node.ready || JSON.stringify(node.children) !== JSON.stringify(children.map(child => child.id))) return false;
  const current = node.children.map(id => record.nodes.find(value => value.id === id));
  if (current.some(value => !value) || JSON.stringify(current.map(value => summarySource(value!))) !== JSON.stringify(children.map(summarySource))) return false;
  requireThat(text.trim(), "历史摘要为空。");
  node.text = text.trim(); node.ready = true; return true;
}

export class HistoryService {
  #records: LocatedRecord[] = [];
  #closed = false;
  #loaded = false;
  #refresh: Promise<void> | undefined;
  #work: Promise<void> | undefined;
  #sourceWarnings: string[] = [];
  #summaryError: string | undefined;
  constructor(readonly root: string, private readonly files: HistoryFiles, private readonly source: HistorySource,
    private readonly otherFiles?: HistoryFiles) {
    requireThat(source.host === files.host && (!otherFiles || otherFiles.host !== files.host), "历史来源与归档目录不匹配。");
  }
  check() { requireThat(!this.#closed, "历史服务已关闭。"); }
  get warnings() { return [...new Set([...this.#sourceWarnings, ...this.files.warnings, ...(this.otherFiles?.warnings ?? []),
    ...(this.#summaryError ? [this.files.host + " 摘要：" + this.#summaryError] : [])])]; }
  get status() { return { loaded: this.#loaded, organizing: Boolean(this.#work), pending: this.#loaded ? this.#records.filter(value => value.host === this.files.host)
    .reduce((total, value) => total + value.record.nodes.filter(node => node.kind === "summary" && !node.ready).length, 0) : null, warnings: this.warnings }; }
  refresh(location: HistoryLocation, signal?: AbortSignal): Promise<void> {
    this.check();
    // Each caller keeps its own cancellation. A closed page cannot cancel a server-owned refresh.
    const work = (this.#refresh ?? Promise.resolve()).catch(() => {}).then(() => this.load(location, signal));
    this.#refresh = work;
    return work.finally(() => { if (this.#refresh === work) this.#refresh = undefined; });
  }
  private async load(location: HistoryLocation, signal?: AbortSignal) {
    this.check(); signal?.throwIfAborted();
    const warnings: string[] = [], records: LocatedRecord[] = [];
    const warning = (host: HistoryHost, error: unknown) => { this.check(); signal?.throwIfAborted(); warnings.push(host + ": " + String(error)); };
    let known: HistoryRecord[] = [];
    try {
      try { this.files.migrate(this.root); } finally { known = this.files.list(); }
      const before = known;
      let sessions: HistorySession[] = [];
      try {
        const scanned = await this.source.scan(location, signal); sessions = scanned.sessions;
        warnings.push(...scanned.warnings.map(value => this.files.host + ": " + value));
      } catch (error) { warning(this.files.host, error); }
      this.check(); signal?.throwIfAborted();
      if (sessions.length) {
        known = this.files.control(() => {
          this.check(); signal?.throwIfAborted();
          const latest = this.files.list(), current = new Map(latest.map(record => [record.sessionId, record]));
          for (const session of sessions) {
            const previous = current.get(session.sessionId), captured = before.find(record => record.sessionId === session.sessionId);
            // An unreadable archive may own this session; avoid assigning it a second root ID.
            if (!previous && this.files.warnings.length) continue;
            // A concurrent source update must not be overwritten by this older scan. Summary-only updates remain reusable.
            if (captured && rawSource(captured) !== rawSource(previous)) continue;
            if (!captured && previous) continue;
            const value = indexHistory(session, previous, this.files.host);
            if (JSON.stringify(previous) !== JSON.stringify(value)) this.files.save(value);
            current.set(session.sessionId, value);
          }
          return [...current.values()];
        });
      }
    } catch (error) { warning(this.files.host, error); }
    records.push(...known.map(record => ({ host: record.host, record })));
    if (this.otherFiles) {
      try { this.otherFiles.migrate(this.root); } catch (error) { warning(this.otherFiles.host, error); }
      try { records.push(...this.otherFiles.list().map(record => ({ host: record.host, record }))); }
      catch (error) { warning(this.otherFiles.host, error); }
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
  /** Only this source is organized. Model calls run outside the write lock. */
  organize(summarize: HistorySummarizer, signal: AbortSignal): Promise<void> {
    this.check();
    const run = async () => {
      for (;;) {
        this.check(); signal.throwIfAborted();
        let pending: { record: HistoryRecord; node: HistoryNode; children: HistoryNode[] } | undefined;
        for (const record of this.files.list()) {
          const lookup = new Map(record.nodes.map(node => [node.id, node]));
          const node = [...record.nodes].sort((a, b) => a.level - b.level).find(node => node.kind === "summary" && !node.ready && node.children.every(id => lookup.get(id)!.ready));
          if (node) { pending = { record, node, children: node.children.map(id => lookup.get(id)!) }; break; }
        }
        if (!pending) return;
        const { record, node, children } = pending;
        const text = await summarize(children.map(child => `[${child.from} — ${child.to}${child.completed ? "" : "；未完成"}]\n${child.text}`).join("\n\n"), signal);
        this.check(); signal.throwIfAborted();
        const committed = this.files.control(() => {
          this.check(); signal.throwIfAborted();
          const current = this.files.list().find(value => value.id === record.id);
          if (!current || !completeHistorySummary(current, node.id, children, text)) return;
          this.files.save(current); return current;
        });
        if (!committed) return;
        this.#records = this.#records.map(value => value.host === this.files.host && value.record.id === committed.id ? { host: value.host, record: committed } : value);
      }
    };
    const work = (this.#work ?? Promise.resolve()).catch(() => {}).then(run).then(() => { this.#summaryError = undefined; }).catch(error => {
      if (!signal.aborted && !this.#closed) this.#summaryError = String(error);
      throw error;
    });
    this.#work = work;
    return work.finally(() => { if (this.#work === work) this.#work = undefined; });
  }
  async close() { this.#closed = true; await Promise.allSettled([this.#work, this.#refresh]); this.#records = []; this.#loaded = false; }
}
