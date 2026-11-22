import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HistoryExchange, HistoryHost, HistoryNode, HistoryRecord, HistorySession, HistorySummary, RawHistory } from "../../model/history.js";
import { requireThat } from "../../common/validation.js";

/** Each native entry has one predecessor. A shortened observation can extend a known path, not erase its prefix. */
function mergeBranches(previous: string[][], observed: string[][], removed: Set<string>): string[][] {
  const parents = new Map<string, string | undefined>();
  for (const branch of [...previous, ...observed]) {
    let parent: string | undefined;
    for (const id of branch) {
      if (removed.has(id)) { parent = undefined; continue; }
      if (parent !== undefined || !parents.has(id)) parents.set(id, parent);
      parent = id;
    }
  }
  const internal = new Set(parents.values()), seen = new Set<string>(), branches: string[][] = [];
  for (const tip of parents.keys()) {
    if (internal.has(tip)) continue;
    const path: string[] = [];
    for (let id: string | undefined = tip; id !== undefined; id = parents.get(id)) {
      requireThat(path.length < parents.size, "历史分支包含循环引用。");
      path.push(id); seen.add(id);
    }
    branches.push(path.reverse());
  }
  requireThat(seen.size === parents.size, "历史分支包含循环引用。");
  return branches;
}

/** Only a native observation can change exchanges or establish branch order. */
export function indexHistory(session: HistorySession, previous?: RawHistory, host: HistoryHost = previous?.host ?? "pi"): RawHistory {
  requireThat(!previous || previous.host === host && previous.sessionId === session.sessionId, "历史会话与归档来源不匹配。");
  const id = previous?.id ?? (host === "pi" ? "" : host + "-") + randomUUID();
  const exchanges = new Map(previous?.exchanges.map(item => [item.id, item]));
  const byEnd = new Map(previous?.exchanges.map(item => [item.entryIds.at(-1)!, item.id]));
  const observed = new Map<string, HistoryExchange>();
  const branches = session.branches.map(branch => branch.map(value => {
    const end = value.entryIds.at(-1)!;
    const key = byEnd.get(end) ?? `${id}:0:${end}`;
    if (!observed.has(end)) {
      observed.set(end, value);
      const before = exchanges.get(key);
      // Compaction can leave only the last inputs and answer of an already archived exchange.
      if (!(before && value.entryIds.length < before.entryIds.length &&
        value.entryIds.every((entry, i) => entry === before.entryIds[before.entryIds.length - value.entryIds.length + i]))) {
        exchanges.set(key, { ...value, entryIds: [...value.entryIds], id: key });
      }
    }
    return key;
  }));
  const removed = new Set<string>();
  for (const end of session.supersededEntryIds ?? []) {
    const key = byEnd.get(end), item = key === undefined ? undefined : exchanges.get(key);
    if (item && !item.completed && !observed.has(end) && [...observed.values()].some(value =>
      item.entryIds.slice(0, -1).every(entry => value.entryIds.includes(entry)))) {
      removed.add(item.id); exchanges.delete(item.id);
    }
  }
  return { host, id, sessionId: session.sessionId, name: session.name, exchanges: [...exchanges.values()],
    branches: mergeBranches(previous?.branches ?? [], branches, removed) };
}

function span(children: HistoryExchange[]) {
  const first = children[0]!, last = children.at(-1)!;
  return { entryIds: [first.entryIds[0]!, last.entryIds.at(-1)!], from: first.from, to: last.to, completed: children.every(child => child.completed) };
}

/** Retire results using changed inputs before publishing a native correction. New groups need no disk write. */
export function retainHistorySummaries(before: RawHistory, after: RawHistory, summaries: HistorySummary[]): HistorySummary[] {
  const inputs = new Map<string, HistoryExchange>(after.exchanges.map(item => [item.id, item]));
  const changed = new Set(before.exchanges.filter(item => !isDeepStrictEqual(item, inputs.get(item.id))).map(item => item.id));
  if (!changed.size || !summaries.length) return summaries;
  const retained = new Map<string, HistorySummary>();
  for (const item of [...summaries].sort((a, b) => a.level - b.level)) {
    const children = item.children.map(id => inputs.get(id));
    if (!children.length || !children.every(child => child !== undefined)) { changed.add(item.id); continue; }
    let summary = item;
    if (item.children.some(id => changed.has(id))) {
      summary = { ...item, ...span(children), text: "", ready: false }; changed.add(item.id);
    }
    retained.set(item.id, summary); inputs.set(item.id, summary);
  }
  return summaries.flatMap(item => retained.get(item.id) ?? []);
}

/** The four-way tree is a query view, never the source of native branch order. */
export function historyView(raw: RawHistory, saved: readonly HistorySummary[] | null = []): HistoryRecord {
  const nodes = new Map<string, HistoryNode>(raw.exchanges.map(value => [value.id,
    { ...value, kind: "exchange", level: 0, ready: true, children: [], parents: [] }]));
  const stored = new Map(saved?.map(value => [value.id, value]));
  const groups = new Map<string, Pick<HistorySummary, "id" | "level" | "children">>(stored);
  for (const branch of raw.branches) {
    let layer = branch.map(id => ({ id, end: nodes.get(id)!.entryIds.at(-1)! }));
    for (let level = 1; layer.length >= 4; level++) {
      const next: typeof layer = [];
      for (let i = 0; i + 4 <= layer.length; i += 4) {
        const end = layer[i + 3]!.end, id = `${raw.id}:${level}:${end}`;
        groups.set(id, { id, level, children: layer.slice(i, i + 4).map(child => child.id) });
        next.push({ id, end });
      }
      layer = next;
    }
  }
  for (const group of [...groups.values()].sort((a, b) => a.level - b.level)) {
    const children = group.children.map(id => nodes.get(id));
    if (!children.length || !children.every(child => child !== undefined)) continue;
    const old = stored.get(group.id);
    const summary = old && isDeepStrictEqual(old.children, group.children) && (!old.ready || children.every(child => child.ready)) ? old :
      { ...group, ...span(children), text: "", ready: false };
    nodes.set(group.id, { ...summary, kind: "summary", parents: [] });
  }
  for (const node of nodes.values()) for (const child of node.children) nodes.get(child)!.parents.push(node.id);
  const top = [...nodes.values()].filter(node => !node.parents.length).sort((a, b) => a.from.localeCompare(b.from));
  for (const child of top) child.parents.push(raw.id);
  const dates = raw.exchanges.flatMap(item => [item.from, item.to]).sort();
  const name = raw.name || raw.exchanges[0]?.text.replace(/\s+/g, " ").slice(0, 80) || "";
  nodes.set(raw.id, { id: raw.id, kind: "session", level: -1, entryIds: [], text: name, ready: true,
    completed: raw.exchanges.every(item => item.completed), from: dates[0] ?? "", to: dates.at(-1) ?? "", parents: [], children: top.map(node => node.id) });
  return { host: raw.host, id: raw.id, sessionId: raw.sessionId, name, nodes: [...nodes.values()] };
}

export function historySummaries(record: HistoryRecord): HistorySummary[] {
  return record.nodes.filter(node => node.kind === "summary").map(({ kind: _kind, parents: _parents, ...summary }) => summary);
}
