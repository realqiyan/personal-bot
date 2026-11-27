import { join } from "node:path";
import { requireThat } from "../../common/validation.js";
import type { HistoryHost, HistoryQuery, RawHistory, SummaryArtifact } from "../../model/history.js";
import {
  HistoryFiles,
  historyBucketFromTimestamp,
  rawHistoryBucket,
  unknownHistoryBucket,
} from "../../storage/history-files.js";
import { readWorkspaceHistoryLayoutSync } from "../workspace/workspace-config.js";
import { orderedRawExchanges, rawSessionSpan, rawSessionTitle } from "./history-index.js";

const summaryIdPrefix = "summary:";

export interface HistoryNodeBrief {
  host: HistoryHost;
  id: string;
  kind: "session" | "exchange" | "summary";
  dimension?: string;
  sessionId: string;
  name: string;
  preview: string;
  from: string;
  to: string;
  ready: boolean;
  completed: boolean;
}

export interface HistorySearchMatch extends HistoryNodeBrief {
  parents: string[];
  snippet: string;
}

export interface HistorySearchResult {
  matches: HistorySearchMatch[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
}

export interface HistoryReadNode extends HistoryNodeBrief {
  text: string;
  totalLength: number;
  nextOffset: number | null;
  parents: HistoryNodeBrief[];
  children: HistoryNodeBrief[];
  nextChildrenOffset: number | null;
  source: {
    host: HistoryHost;
    sessionId: string;
    entryIds: string[];
    dimension?: string;
  };
  warnings: string[];
}

const page = <T>(values: readonly T[], offset: number, limit: number) => ({
  values: values.slice(offset, offset + limit),
  nextOffset: offset + limit < values.length ? offset + limit : null,
});

const previewText = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 100);

export function summaryNodeId(dimension: string, artifactId: string): string {
  return `${summaryIdPrefix}${dimension}:${artifactId}`;
}

export function parseSummaryNodeId(id: string): { dimension: string; artifactId: string } | undefined {
  if (!id.startsWith(summaryIdPrefix)) return undefined;
  const rest = id.slice(summaryIdPrefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { dimension: rest.slice(0, sep), artifactId: rest.slice(sep + 1) };
}

function parseExchangeNodeId(id: string): { rawId: string } | undefined {
  const index = id.indexOf(":0:");
  if (index <= 0) return undefined;
  return { rawId: id.slice(0, index) };
}

function sessionBrief(raw: RawHistory, summaryPreview?: string): HistoryNodeBrief {
  const ordered = orderedRawExchanges(raw);
  const span = rawSessionSpan(ordered);
  const name = rawSessionTitle(raw);
  return {
    host: raw.host,
    id: raw.id,
    kind: "session",
    sessionId: raw.sessionId,
    name,
    preview: summaryPreview ? previewText(summaryPreview) : previewText(name || ordered[0]?.text || ""),
    from: span.from,
    to: span.to,
    ready: true,
    completed: span.completed,
  };
}

function exchangeBrief(raw: RawHistory, exchange: RawHistory["exchanges"][number], title: string): HistoryNodeBrief {
  return {
    host: raw.host,
    id: exchange.id,
    kind: "exchange",
    sessionId: raw.sessionId,
    name: title,
    preview: previewText(exchange.text),
    from: exchange.from,
    to: exchange.to,
    ready: true,
    completed: exchange.completed,
  };
}

function summaryBrief(artifact: SummaryArtifact): HistoryNodeBrief {
  return {
    host: artifact.host ?? "workspace",
    id: summaryNodeId(artifact.dimension, artifact.id),
    kind: "summary",
    dimension: artifact.dimension,
    sessionId: artifact.sessionId ?? artifact.id,
    name: artifact.title,
    preview: previewText(artifact.text),
    from: artifact.from,
    to: artifact.to,
    ready: true,
    completed: true,
  };
}

function sliceSnippet(text: string, needle: string): string {
  if (!needle) return text.slice(0, 400);
  const start = Math.max(0, text.toLowerCase().indexOf(needle) - 80);
  return text.slice(start, start + 400);
}

function inTimeRange(from: string, to: string, after: number, before: number): boolean {
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  if (after !== -Infinity && !Number.isNaN(toMs) && toMs < after) return false;
  if (before !== Infinity && !Number.isNaN(fromMs) && fromMs > before) return false;
  return true;
}

/**
 * Isolated, stateless read-only search over .pbot/history/raw/ and .pbot/history/summaries/<dimension>/.
 * Uses ripgrep (with automatic Node fallback) to pre-filter candidate JSON files before parsing.
 */
export function searchWorkspaceHistory(root: string, query: HistoryQuery = {}): HistorySearchResult {
  const { host, sessionId, dimension, from, to, offset = 0, limit = 20 } = query;
  const needle = (query.query ?? "").trim().toLowerCase();
  const after = from === undefined ? -Infinity : Date.parse(from);
  const before = to === undefined ? Infinity : Date.parse(to);
  requireThat(!Number.isNaN(after) && !Number.isNaN(before) && after <= before, "时间范围无效，请使用 ISO 日期或时间。");

  const layout = readWorkspaceHistoryLayoutSync(root);
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", layout);
  const warnings: string[] = [];
  if (layout === "monthly") {
    const flatNotice = files.detectFlatFiles().message;
    if (flatNotice) warnings.push(flatNotice);
  }
  const matches: HistorySearchMatch[] = [];

  if (!needle) {
    // Empty query: list sessions (default / dimension="raw") or list summaries of a specific dimension.
    if (dimension && dimension !== "raw") {
      const summaries = files.listSummaries(dimension);
      warnings.push(...files.warnings);
      for (const artifact of summaries) {
        if (host && artifact.host !== host) continue;
        if (sessionId && artifact.sessionId !== sessionId) continue;
        if (!inTimeRange(artifact.from, artifact.to, after, before)) continue;
        const brief = summaryBrief(artifact);
        matches.push({
          ...brief,
          parents: artifact.dimension === "monthly" ? [] : artifact.source.rawIds,
          snippet: sliceSnippet(artifact.text, ""),
        });
      }
    } else {
      const raws = files.listRaw(host);
      warnings.push(...files.warnings);
      const sessionSummaries = new Map(files.listSummaries("session").map(item => [item.id, item]));
      warnings.push(...files.warnings);
      for (const raw of raws) {
        if (sessionId && raw.sessionId !== sessionId) continue;
        const summary = sessionSummaries.get(raw.id);
        const brief = sessionBrief(raw, summary?.text);
        if (!inTimeRange(brief.from, brief.to, after, before)) continue;
        matches.push({
          ...brief,
          parents: [],
          snippet: summary ? sliceSnippet(summary.text, "") : brief.preview,
        });
      }
    }
  } else {
    // Keyword query: pre-filter candidate files via rg/fallback, then parse and match exact fields.
    const searchRaw = !dimension || dimension === "raw";
    const summaryDimensions = dimension === "raw"
      ? []
      : dimension
        ? [dimension]
        : files.listDimensions();

    if (searchRaw) {
      const candidateRaws = files.searchCandidateRaw(needle);
      warnings.push(...files.warnings);
      for (const raw of candidateRaws) {
        if (host && raw.host !== host) continue;
        if (sessionId && raw.sessionId !== sessionId) continue;
        const ordered = orderedRawExchanges(raw);
        const title = rawSessionTitle(raw);
        for (const item of ordered) {
          if (!item.text.toLowerCase().includes(needle)) continue;
          if (!inTimeRange(item.from, item.to, after, before)) continue;
          matches.push({
            ...exchangeBrief(raw, item, title),
            parents: [raw.id],
            snippet: sliceSnippet(item.text, needle),
          });
        }
      }
    }

    for (const dim of summaryDimensions) {
      const candidateSummaries = files.searchCandidateSummaries(dim, needle);
      warnings.push(...files.warnings);
      for (const artifact of candidateSummaries) {
        if (host && artifact.host !== host) continue;
        if (sessionId && artifact.sessionId !== sessionId) continue;
        const searchable = `${artifact.title}\n${artifact.text}`;
        if (!searchable.toLowerCase().includes(needle)) continue;
        if (!inTimeRange(artifact.from, artifact.to, after, before)) continue;
        matches.push({
          ...summaryBrief(artifact),
          parents: artifact.dimension === "monthly" ? [] : artifact.source.rawIds,
          snippet: sliceSnippet(artifact.text, needle),
        });
      }
    }
  }

  matches.sort((a, b) => b.to.localeCompare(a.to) || a.id.localeCompare(b.id));
  const paged = page(matches, offset, limit);
  return {
    matches: paged.values,
    total: matches.length,
    nextOffset: paged.nextOffset,
    warnings: [...new Set(warnings)],
  };
}

function sliceText(text: string, offset: number, limit: number) {
  requireThat(offset <= text.length, "读取位置超出正文。");
  let start = offset;
  if (start && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
  let end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end += end - start === 1 ? 1 : -1;
  return {
    text: text.slice(start, end),
    totalLength: text.length,
    nextOffset: end < text.length ? end : null,
  };
}

function findMonthlyParent(files: HistoryFiles, bucket: string, rawId: string): HistoryNodeBrief | undefined {
  if (files.layout !== "monthly" || bucket === unknownHistoryBucket) return undefined;
  const monthly = files.readSummary("monthly", bucket.replace("/", "-"));
  if (!monthly || !monthly.source.rawIds.includes(rawId)) return undefined;
  return summaryBrief(monthly);
}

/** O(1) read of a session root, summary artifact, or individual raw exchange. */
export function readWorkspaceHistory(
  root: string,
  id: string,
  offset = 0,
  limit = 12000,
  childrenOffset = 0,
  host?: HistoryHost,
): HistoryReadNode {
  const layout = readWorkspaceHistoryLayoutSync(root);
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", layout);
  const baseWarnings: string[] = [];
  if (layout === "monthly") {
    const flatNotice = files.detectFlatFiles().message;
    if (flatNotice) baseWarnings.push(flatNotice);
  }

  // 1. Summary artifact: summary:<dimension>:<artifactId>
  const parsedSummary = parseSummaryNodeId(id);
  if (parsedSummary) {
    const artifact = files.readSummary(parsedSummary.dimension, parsedSummary.artifactId);
    requireThat(artifact && (!host || artifact.host === host), "历史节点不存在，请重新搜索。");
    const parents: HistoryNodeBrief[] = [];
    const children: HistoryNodeBrief[] = [];

    if (artifact.dimension === "monthly") {
      // Monthly summary drills down to per-session summaries (falling back to raw session roots).
      for (const rawId of artifact.source.rawIds) {
        const sessionSummary = files.readSummary("session", rawId);
        if (sessionSummary) {
          children.push(summaryBrief(sessionSummary));
          continue;
        }
        const raw = files.readRaw(rawId);
        if (raw) children.push(sessionBrief(raw));
      }
    } else {
      const wantedExchanges = new Set(artifact.source.exchangeIds);
      for (const rawId of artifact.source.rawIds) {
        const raw = files.readRaw(rawId);
        if (!raw) continue;
        parents.push(sessionBrief(raw, artifact.dimension === "session" ? artifact.text : undefined));
        const ordered = orderedRawExchanges(raw);
        const title = rawSessionTitle(raw);
        for (const item of ordered) {
          if (!wantedExchanges.size || wantedExchanges.has(item.id)) {
            children.push(exchangeBrief(raw, item, title));
          }
        }
      }
      if (artifact.dimension === "session") {
        const bucket = historyBucketFromTimestamp(artifact.from || artifact.to);
        const monthlyParent = findMonthlyParent(files, bucket, artifact.id);
        if (monthlyParent) parents.push(monthlyParent);
      }
    }

    const pagedChildren = page(children, childrenOffset, 20);
    const sliced = sliceText(artifact.text, offset, limit);
    return {
      ...summaryBrief(artifact),
      ...sliced,
      parents,
      children: pagedChildren.values,
      nextChildrenOffset: pagedChildren.nextOffset,
      source: {
        host: artifact.host ?? "workspace",
        sessionId: artifact.sessionId ?? artifact.id,
        entryIds: artifact.source.exchangeIds,
        dimension: artifact.dimension,
      },
      warnings: [...new Set([...baseWarnings, ...files.warnings])],
    };
  }

  // 2. Raw exchange: <rawId>:0:<end>
  const parsedExchange = parseExchangeNodeId(id);
  if (parsedExchange) {
    const raw = files.readRaw(parsedExchange.rawId);
    requireThat(raw && (!host || raw.host === host), "历史节点不存在，请重新搜索。");
    const exchange = raw.exchanges.find(item => item.id === id);
    requireThat(exchange, "历史节点不存在，请重新搜索。");
    const title = rawSessionTitle(raw);
    const parents: HistoryNodeBrief[] = [sessionBrief(raw)];
    for (const dim of files.listDimensions()) {
      if (dim === "monthly") continue;
      const artifact = files.readSummary(dim, raw.id);
      if (artifact) parents.push(summaryBrief(artifact));
    }
    const sliced = sliceText(exchange.text, offset, limit);
    return {
      ...exchangeBrief(raw, exchange, title),
      ...sliced,
      parents,
      children: [],
      nextChildrenOffset: null,
      source: {
        host: raw.host,
        sessionId: raw.sessionId,
        entryIds: exchange.entryIds,
      },
      warnings: [...new Set([...baseWarnings, ...files.warnings])],
    };
  }

  // 3. Session root: <rawId>
  const raw = files.readRaw(id);
  requireThat(raw && (!host || raw.host === host), "历史节点不存在，请重新搜索。");
  const ordered = orderedRawExchanges(raw);
  const title = rawSessionTitle(raw);
  const summaryChildren: HistoryNodeBrief[] = [];
  let sessionSummaryText: string | undefined;
  for (const dim of files.listDimensions()) {
    if (dim === "monthly") continue;
    const artifact = files.readSummary(dim, raw.id);
    if (!artifact) continue;
    if (dim === "session") sessionSummaryText = artifact.text;
    summaryChildren.push(summaryBrief(artifact));
  }
  const monthlyParent = findMonthlyParent(files, rawHistoryBucket(raw), raw.id);
  const allChildren: HistoryNodeBrief[] = [
    ...summaryChildren,
    ...ordered.map(item => exchangeBrief(raw, item, title)),
  ];
  const pagedChildren = page(allChildren, childrenOffset, 20);
  const body = sessionSummaryText ? (title ? `${title}\n\n${sessionSummaryText}` : sessionSummaryText) : title;
  const sliced = sliceText(body, offset, limit);
  return {
    ...sessionBrief(raw, sessionSummaryText),
    ...sliced,
    parents: monthlyParent ? [monthlyParent] : [],
    children: pagedChildren.values,
    nextChildrenOffset: pagedChildren.nextOffset,
    source: {
      host: raw.host,
      sessionId: raw.sessionId,
      entryIds: ordered.flatMap(item => item.entryIds),
    },
    warnings: [...new Set([...baseWarnings, ...files.warnings])],
  };
}
