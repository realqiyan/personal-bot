import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { HistoryExchange, HistoryHost, HistoryIdentity, HistoryRecord, HistorySummary, RawHistory } from "../model/history.js";
import { fileId } from "./file-access.js";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const fields = (value: object, names: readonly string[]) => Object.keys(value).every(key => names.includes(key));
const rawFields = ["host", "id", "sessionId", "name", "exchanges", "branches"];
const hierarchyFields = ["host", "id", "sessionId", "summaries"];
const exchangeFields = ["id", "entryIds", "text", "from", "to", "completed"];
const summaryFields = [...exchangeFields, "level", "children", "ready"];

export const isHistoryHost = (value: unknown): value is HistoryHost => value === "pi" || value === "dsh" || value === "claude";

function identity(value: unknown): asserts value is HistoryIdentity {
  requireThat(object(value) && isHistoryHost(value.host) && typeof value.id === "string" &&
    typeof value.sessionId === "string" && value.sessionId.length > 0, "历史归档身份无效。");
  fileId(value.id);
}

export function matchIdentity(value: HistoryIdentity, expected: HistoryIdentity) {
  for (const key of ["host", "id", "sessionId"] as const) {
    requireThat(value[key] === expected[key], `历史归档 ${key} 不匹配，预期 ${expected[key]}，实际 ${value[key]}。`);
  }
}

function exchange(value: unknown): value is HistoryExchange & { id: string } {
  return object(value) && typeof value.id === "string" && value.id.length > 0 && strings(value.entryIds) &&
    typeof value.text === "string" && typeof value.from === "string" && typeof value.to === "string" && typeof value.completed === "boolean";
}

export function rawHistory(value: unknown): RawHistory {
  identity(value);
  requireThat(object(value) && fields(value, rawFields) && typeof value.name === "string" &&
    Array.isArray(value.exchanges) && Array.isArray(value.branches), "历史原文归档无效。");
  const ids = new Set<string>();
  for (const item of value.exchanges) {
    requireThat(exchange(item) && fields(item, exchangeFields) && item.entryIds.length > 0, "历史问答或其来源消息 ID 无效。");
    requireThat(item.id !== value.id && !ids.has(item.id), "历史问答 ID 重复：" + item.id);
    ids.add(item.id);
  }
  for (const branch of value.branches) requireThat(strings(branch) && new Set(branch).size === branch.length && branch.every(id => ids.has(id)),
    "历史分支包含重复或未知的问答 ID。");
  return value as unknown as RawHistory;
}

export interface HierarchicalHistory extends HistoryIdentity { summaries: HistorySummary[] }

export function hierarchicalHistory(value: unknown, raw: RawHistory): HierarchicalHistory {
  identity(value);
  matchIdentity(value, raw);
  requireThat(object(value) && fields(value, hierarchyFields) && Array.isArray(value.summaries), "历史摘要归档无效。");
  const levels = new Map(raw.exchanges.map(item => [item.id, 0]));
  for (const item of value.summaries) {
    requireThat(object(item) && exchange(item) && fields(item, summaryFields) && item.entryIds.length > 0 &&
      typeof item.level === "number" && Number.isSafeInteger(item.level) && item.level > 0 && strings(item.children) && typeof item.ready === "boolean", "历史摘要节点无效。");
    requireThat(item.id !== raw.id && !levels.has(item.id), "历史摘要 ID 重复：" + item.id);
    levels.set(item.id, item.level);
  }
  const result = value as unknown as HierarchicalHistory;
  for (const item of result.summaries) requireThat(item.children.length > 0 && new Set(item.children).size === item.children.length &&
    item.children.every(id => levels.get(id) === item.level - 1), "历史摘要子节点缺失、重复或层级不匹配：" + item.id);
  return result;
}

/** Old private directories carried the host in their path. Shared records must declare it. */
export function legacyHistory(value: unknown, host?: HistoryHost): HistoryRecord {
  if (host !== undefined) {
    requireThat(object(value) && (value.host === undefined || value.host === host), "旧历史归档与来源目录不匹配。");
    value = { ...value, host };
  }
  identity(value);
  requireThat(object(value) && typeof value.name === "string" && Array.isArray(value.nodes) &&
    !("exchanges" in value) && !("branches" in value) && !("summaries" in value), "旧历史归档无效。");
  for (const node of value.nodes) requireThat(object(node) && exchange(node) &&
    (node.kind === "session" || node.kind === "exchange" || node.kind === "summary") && Number.isInteger(node.level) &&
    strings(node.parents) && strings(node.children) && typeof node.ready === "boolean", "旧历史节点无效。");
  const result = value as unknown as HistoryRecord, ids = new Set(result.nodes.map(node => node.id));
  const roots = result.nodes.filter(node => node.kind === "session");
  requireThat(ids.size === result.nodes.length && roots.length === 1 && roots[0]!.id === result.id &&
    result.nodes.every(node => [...node.parents, ...node.children].every(id => ids.has(id))), "旧历史节点关系无效。");
  return result;
}

function exchangeData({ id, entryIds, text, from, to, completed }: HistoryExchange & { id: string }) {
  return { id, entryIds, text, from, to, completed };
}

export function summaryData(item: HistorySummary): HistorySummary {
  return { ...exchangeData(item), level: item.level, children: item.children, ready: item.ready };
}

export function splitLegacy(record: HistoryRecord): { raw: RawHistory; summaries: HistorySummary[] } {
  const { host, id, sessionId, name } = record;
  const raw = rawHistory({ host, id, sessionId, name, exchanges: record.nodes.filter(node => node.kind === "exchange").map(exchangeData), branches: [] });
  const summaries = record.nodes.filter(node => node.kind === "summary").map(summaryData);
  return { raw, summaries: hierarchicalHistory({ host, id, sessionId, summaries }, raw).summaries };
}
