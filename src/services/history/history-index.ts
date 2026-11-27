import { createHash, randomUUID } from "node:crypto";
import type { HistoryExchange, HistoryHost, HistorySession, RawHistory } from "../../model/history.js";
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

/** Merge a native session observation into its raw archive without modifying persisted order invariants. */
export function indexHistory(session: HistorySession, previous?: RawHistory, host: HistoryHost = previous?.host ?? "pi"): RawHistory {
  requireThat(!previous || (previous.host === host && previous.sessionId === session.sessionId), "历史会话与归档来源不匹配。");
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
  return {
    host,
    id,
    sessionId: session.sessionId,
    name: session.name,
    exchanges: [...exchanges.values()],
    branches: mergeBranches(previous?.branches ?? [], branches, removed),
  };
}

/** Return deduplicated exchanges in conversation order (branch order first, then any unbranched entries by timestamp). */
export function orderedRawExchanges(raw: RawHistory): (HistoryExchange & { id: string })[] {
  const lookup = new Map(raw.exchanges.map(item => [item.id, item]));
  const seen = new Set<string>();
  const ordered: (HistoryExchange & { id: string })[] = [];
  for (const branch of raw.branches) {
    for (const id of branch) {
      if (seen.has(id)) continue;
      const item = lookup.get(id);
      if (!item) continue;
      seen.add(id);
      ordered.push(item);
    }
  }
  const rest = raw.exchanges
    .filter(item => !seen.has(item.id))
    .sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
  ordered.push(...rest);
  return ordered;
}

export function rawSessionTitle(raw: RawHistory): string {
  return raw.name.trim();
}

export function rawSessionSpan(exchanges: readonly HistoryExchange[]): { from: string; to: string; completed: boolean } {
  const dates = exchanges.flatMap(item => [item.from, item.to]).filter(Boolean).sort();
  return {
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    completed: exchanges.every(item => item.completed),
  };
}

/** Stable SHA-256 fingerprint over ordered exchange contents for exact deduplication and prefix matching. */
export function fingerprintExchanges(exchanges: readonly (HistoryExchange & { id: string })[]): string {
  const hash = createHash("sha256");
  for (const item of exchanges) {
    hash.update(JSON.stringify([item.id, item.entryIds, item.text, item.from, item.to, item.completed]));
    hash.update("\n");
  }
  return hash.digest("hex");
}
