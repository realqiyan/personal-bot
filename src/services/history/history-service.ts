import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { HistoryExchange, HistoryLocation, HistoryNode, HistoryRecord, HistorySession, HistorySource, HistorySummarizer } from "../../model/history.js";
import type { HistoryFiles } from "../../storage/history-files.js";
import { requireThat } from "../../common/validation.js";

/** Shared prefixes reuse nodes; only consecutive exchanges on one native branch can merge. */
export function indexHistory(workspace: string, session: HistorySession, previous?: HistoryRecord): HistoryRecord {
  const id = previous?.id ?? randomUUID(), nodes = new Map<string, HistoryNode>();
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
  return { id, sessionId: session.sessionId, file: relative(workspace, session.file), name: session.name, nodes: [...nodes.values()] };
}

export interface HistoryQuery { query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
const page = <T>(values: T[], offset: number, limit: number) => ({ values: values.slice(offset, offset + limit),
  nextOffset: offset + limit < values.length ? offset + limit : null });
const brief = (record: HistoryRecord, node: HistoryNode) => ({ id: node.id, kind: node.kind, sessionId: record.sessionId,
  name: record.name, preview: node.text.replace(/\s+/g, " ").slice(0, 100), from: node.from, to: node.to, ready: node.ready, completed: node.completed });

export class HistoryService {
  #records: HistoryRecord[] = [];
  #closed = false;
  #refresh: Promise<void> | undefined;
  #work: Promise<void> | undefined;
  warnings: string[] = [];
  constructor(readonly root: string, private readonly files: HistoryFiles, private readonly source: HistorySource,
    private previousFiles?: HistoryFiles) {}
  check() { requireThat(!this.#closed, "历史服务已关闭。"); }
  refresh(location: HistoryLocation, signal?: AbortSignal): Promise<void> {
    this.check();
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.load(location, signal).finally(() => { this.#refresh = undefined; });
    return this.#refresh;
  }
  private async load(location: HistoryLocation, signal?: AbortSignal) {
    const previous = this.files.list();
    for (const { id, sessionId, file, name, nodes } of this.previousFiles?.list(this.root) ?? []) {
      if (previous.some(record => record.sessionId === sessionId)) continue;
      const value = { id, sessionId, file: relative(this.root, file), name, nodes };
      this.files.save(value); previous.push(value);
    }
    this.previousFiles = undefined;
    const { sessions, warnings } = await this.source.scan(location, previous.map(record => resolve(this.root, record.file)), signal);
    this.check(); signal?.throwIfAborted();
    const known = new Map(this.files.list().map(record => [record.sessionId, record]));
    for (const session of sessions) {
      const before = known.get(session.sessionId), value = indexHistory(this.root, session, before);
      if (JSON.stringify(before) !== JSON.stringify(value)) this.files.save(value);
      known.set(session.sessionId, value);
    }
    this.#records = [...known.values()];
    this.warnings = warnings;
  }
  search({ query = "", sessionId, from, to, offset = 0, limit = 20 }: HistoryQuery = {}) {
    this.check();
    const needle = query.trim().toLowerCase(), after = from === undefined ? -Infinity : Date.parse(from), before = to === undefined ? Infinity : Date.parse(to);
    requireThat(!Number.isNaN(after) && !Number.isNaN(before) && after <= before, "时间范围无效，请使用 ISO 日期或时间。");
    const matches = this.#records.filter(record => !sessionId || record.sessionId === sessionId).flatMap(record => record.nodes
      .filter(node => (needle ? node.kind !== "session" && node.ready && node.text.toLowerCase().includes(needle) : node.kind === "session") &&
        Date.parse(node.to) >= after && Date.parse(node.from) <= before)
      .map(node => {
        const start = Math.max(0, node.text.toLowerCase().indexOf(needle) - 80);
        return { ...brief(record, node), parents: node.parents, snippet: node.text.slice(start, start + 400) };
      })).sort((a, b) => b.to.localeCompare(a.to) || a.id.localeCompare(b.id));
    const result = page(matches, offset, limit);
    return { matches: result.values, total: matches.length, nextOffset: result.nextOffset, warnings: this.warnings };
  }
  private find(id: string) {
    const record = this.#records.find(record => record.nodes.some(node => node.id === id));
    const node = record?.nodes.find(node => node.id === id);
    requireThat(record && node, "历史节点不存在，请重新搜索。");
    return { record, node };
  }
  read(id: string, offset = 0, limit = 12000, childrenOffset = 0) {
    this.check();
    const { record, node } = this.find(id), lookup = new Map(record.nodes.map(value => [value.id, value]));
    requireThat(offset <= node.text.length, "读取位置超出正文。");
    if (offset && /[\uDC00-\uDFFF]/.test(node.text[offset] ?? "")) offset--;
    let end = Math.min(node.text.length, offset + limit);
    if (end < node.text.length && /[\uD800-\uDBFF]/.test(node.text[end - 1] ?? "")) end += end - offset === 1 ? 1 : -1;
    const children = page(node.children, childrenOffset, 20);
    return { ...brief(record, node), text: node.text.slice(offset, end), totalLength: node.text.length,
      nextOffset: end < node.text.length ? end : null,
      parents: node.parents.map(id => brief(record, lookup.get(id)!)), children: children.values.map(id => brief(record, lookup.get(id)!)),
      nextChildrenOffset: children.nextOffset, source: { file: record.file, entryIds: node.entryIds }, warnings: this.warnings };
  }
  /** One worker per workspace instance. Failed or cancelled nodes remain pending for the next idle period. */
  organize(summarize: HistorySummarizer, signal: AbortSignal): Promise<void> {
    this.check();
    const run = async () => {
      for (const record of this.#records) {
        const lookup = new Map(record.nodes.map(node => [node.id, node]));
        for (const node of [...record.nodes].sort((a, b) => a.level - b.level)) {
          this.check(); signal.throwIfAborted();
          if (node.kind !== "summary" || node.ready) continue;
          const children = node.children.map(id => lookup.get(id)!);
          if (children.some(child => !child.ready)) continue;
          const text = await summarize(children.map(child => `[${child.from} — ${child.to}${child.completed ? "" : "；未完成"}]\n${child.text}`).join("\n\n"), signal);
          this.check(); signal.throwIfAborted();
          // A query may have refreshed the source while this model request was running.
          if (!this.#records.includes(record)) return;
          requireThat(text.trim(), "历史摘要为空。");
          node.text = text.trim(); node.ready = true; this.files.save(record);
        }
      }
    };
    const work = (this.#work ?? Promise.resolve()).catch(() => {}).then(run);
    this.#work = work;
    return work.finally(() => { if (this.#work === work) this.#work = undefined; });
  }
  async close() { this.#closed = true; await Promise.allSettled([this.#work, this.#refresh]); }
}
