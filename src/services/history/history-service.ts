import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryExchange, HistoryHost, HistoryLocation, HistoryNode, HistoryRecord, HistorySession, HistorySource, HistorySummarizer } from "../../model/history.js";
import type { HistoryFiles } from "../../storage/history-files.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";

const exchangeSource = (value: HistoryExchange) => [value.entryIds, value.text, value.from, value.to, value.completed];

/** Shared prefixes reuse nodes; a partial scan updates observed nodes and retains archived branches. */
export function indexHistory(session: HistorySession, previous?: HistoryRecord, host: HistoryHost = previous?.host ?? "pi"): HistoryRecord {
  requireThat(!previous || previous.host === host && previous.sessionId === session.sessionId, "历史会话与归档来源不匹配。");
  const id = previous?.id ?? (host === "pi" ? "" : host + "-") + randomUUID();
  const old = new Map(previous?.nodes.map(node => [node.id, node]));
  const nodes = new Map<string, HistoryNode>(previous?.nodes.filter(node => node.kind !== "session").map(node => [node.id, {
    ...node, entryIds: [...node.entryIds], children: [...node.children], parents: [],
  }] satisfies [string, HistoryNode]));
  const exchanges = session.branches.flat(), observedEnds = new Set(exchanges.map(value => value.entryIds.at(-1)));
  const replaced = new Set(session.supersededEntryIds);
  const superseded = new Set([...nodes.values()].filter(node => node.kind === "exchange" && !node.completed &&
    !observedEnds.has(node.entryIds.at(-1)) && replaced.has(node.entryIds.at(-1)!) &&
    exchanges.some(exchange => node.entryIds.slice(0, -1).every(entry => exchange.entryIds.includes(entry)))).map(node => node.id));
  // Native adapters identify replaced observations along the same branch/turn. Preserve
  // terminal forks and interrupted exchanges, then rebuild summaries that used old partials.
  for (const node of [...nodes.values()].filter(node => node.kind === "summary").sort((a, b) => a.level - b.level)) {
    if (node.children.some(id => superseded.has(id))) superseded.add(node.id);
  }
  for (const key of superseded) nodes.delete(key);
  const observed = new Set<string>(), changed = new Set<string>();
  const add = (value: HistoryExchange, level: number, children: string[] = []): HistoryNode => {
    const key = `${id}:${level}:${value.entryIds.at(-1)}`;
    if (observed.has(key)) return nodes.get(key)!;
    const before = old.get(key);
    if (!level && before && value.entryIds.length < before.entryIds.length &&
      value.entryIds.every((entry, index) => entry === before.entryIds[before.entryIds.length - value.entryIds.length + index])) {
      observed.add(key); return nodes.get(key)!;
    }
    const same = before && JSON.stringify(before.children) === JSON.stringify(children) &&
      JSON.stringify(exchangeSource({ ...before, text: level ? "" : before.text })) === JSON.stringify(exchangeSource(value));
    const node: HistoryNode = { ...value, entryIds: [...value.entryIds], id: key, kind: level ? "summary" : "exchange", level, children, parents: [],
      text: level ? same ? before.text : "" : value.text, ready: level ? Boolean(same && before.ready) : true };
    if (!same) changed.add(key);
    observed.add(key); nodes.set(key, node); return node;
  };
  for (const branch of session.branches) {
    let layer = branch.map(exchange => add(exchange, 0)), level = 1;
    while (layer.length >= 4) {
      const count = Math.floor(layer.length / 4) * 4, next: HistoryNode[] = [];
      for (let i = 0; i < count; i += 4) {
        const children = layer.slice(i, i + 4), first = children[0]!, last = children.at(-1)!;
        next.push(add({ entryIds: [first.entryIds[0]!, last.entryIds.at(-1)!], text: "", from: first.from, to: last.to,
          completed: children.every(node => node.completed) }, level, children.map(node => node.id)));
      }
      layer = next; level++;
    }
  }
  // Retained summaries can also depend on an observed prefix. Invalidate all affected ancestors.
  for (const node of [...nodes.values()].filter(node => node.kind === "summary").sort((a, b) => a.level - b.level)) {
    const children = node.children.map(id => nodes.get(id)!), first = children[0]!, last = children.at(-1)!;
    const value = { entryIds: [first.entryIds[0]!, last.entryIds.at(-1)!], from: first.from, to: last.to,
      completed: children.every(child => child.completed) };
    if (children.some(child => changed.has(child.id))) { node.text = ""; node.ready = false; changed.add(node.id); }
    Object.assign(node, value);
  }
  const dates = [...nodes.values()].flatMap(node => [node.from, node.to]).sort();
  const nested = new Set([...nodes.values()].flatMap(node => node.children));
  nodes.set(id, { id, kind: "session", level: -1, entryIds: [], text: session.name, ready: true, completed: [...nodes.values()].every(node => node.completed),
    from: dates[0] ?? "", to: dates.at(-1) ?? "", parents: [],
    children: [...nodes.keys()].filter(key => !nested.has(key)).sort((a, b) => nodes.get(a)!.from.localeCompare(nodes.get(b)!.from)) });
  for (const node of nodes.values()) for (const child of node.children) nodes.get(child)!.parents.push(node.id);
  return { host, id, sessionId: session.sessionId, name: session.name, nodes: [...nodes.values()] };
}

export interface HistoryQuery { host?: HistoryHost; query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
type LocatedRecord = { host: HistoryHost; record: HistoryRecord };
type HistoryReader = Pick<HistoryFiles, "host" | "list" | "warnings">;
const page = <T>(values: T[], offset: number, limit: number) => ({ values: values.slice(offset, offset + limit),
  nextOffset: offset + limit < values.length ? offset + limit : null });
const brief = ({ host, record }: LocatedRecord, node: HistoryNode) => ({ host, id: node.id, kind: node.kind, sessionId: record.sessionId,
  name: record.name, preview: node.text.replace(/\s+/g, " ").slice(0, 100), from: node.from, to: node.to, ready: node.ready, completed: node.completed });
const rawSource = (record?: HistoryRecord) => record && JSON.stringify({ name: record.name,
  nodes: record.nodes.map(node => [node.id, node.kind, node.level, node.entryIds, node.children,
    node.kind === "summary" ? "" : node.text, node.from, node.to, node.completed]) });
const summarySource = (node: HistoryNode) => [node.id, node.kind, node.level, node.entryIds, node.children, node.text, node.from, node.to, node.completed, node.ready];

/** Validate the exact target and ordered inputs again; another writer's ready summary wins. */
export function completeHistorySummary(record: HistoryRecord, expected: HistoryNode, children: readonly HistoryNode[], text: string) {
  const node = record.nodes.find(value => value.id === expected.id);
  if (!node || node.kind !== "summary" || node.ready || JSON.stringify(summarySource(node)) !== JSON.stringify(summarySource(expected)) ||
    JSON.stringify(node.children) !== JSON.stringify(children.map(child => child.id))) return false;
  const current = node.children.map(id => record.nodes.find(value => value.id === id));
  if (current.some(value => !value || !value.ready) || JSON.stringify(current.map(value => summarySource(value!))) !== JSON.stringify(children.map(summarySource))) return false;
  requireThat(text.trim(), "历史摘要为空。");
  node.text = text.trim(); node.ready = true; return true;
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
    private readonly otherFiles: readonly HistoryReader[] = []) {
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
    for (const files of this.otherFiles) {
      try { records.push(...files.list(this.root).map(record => ({ host: record.host, record }))); }
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
        const pending = this.files.list().flatMap(record => {
          const lookup = new Map(record.nodes.map(node => [node.id, node]));
          const node = [...record.nodes].sort((a, b) => a.level - b.level).find(node => node.kind === "summary" && !node.ready && node.children.every(id => lookup.get(id)!.ready));
          return node ? [{ record, node, children: node.children.map(id => lookup.get(id)!) }] : [];
        })[0];
        if (!pending) return;
        const { record, node, children } = pending;
        const text = await summarize({ system: readFileSync(join(resourceRoot, "prompts/history-summary.md"), "utf8"), maxTokens: 2048,
          prompt: children.map(child => `[${child.from} — ${child.to}${child.completed ? "" : "；未完成"}]\n${child.text}`).join("\n\n") }, active);
        this.check(); active.throwIfAborted();
        const committed = this.files.control(() => {
          this.check(); active.throwIfAborted();
          const current = this.files.list().find(value => value.id === record.id && value.sessionId === record.sessionId);
          if (!current || !completeHistorySummary(current, node, children, text)) return;
          this.files.save(current); return current;
        });
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
