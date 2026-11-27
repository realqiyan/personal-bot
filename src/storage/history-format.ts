import { object } from "../common/json.js";
import { requireThat } from "../common/validation.js";
import type { HistoryExchange, HistoryHost, HistoryIdentity, RawHistory, SummaryArtifact } from "../model/history.js";
import { fileId } from "./file-access.js";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const fields = (value: object, names: readonly string[]) => Object.keys(value).every(key => names.includes(key));

const rawFields = ["host", "id", "sessionId", "name", "exchanges", "branches"];
const exchangeFields = ["id", "entryIds", "text", "from", "to", "completed"];
const summaryArtifactFields = ["id", "dimension", "host", "sessionId", "title", "text", "from", "to", "updatedAt", "source"];
const summarySourceFields = ["rawIds", "exchangeIds", "fingerprint"];

const identifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isHistoryHost = (value: unknown): value is HistoryHost => typeof value === "string" && identifierPattern.test(value);
export const isSummaryDimension = (value: unknown): value is string => typeof value === "string" && identifierPattern.test(value);

function identity(value: unknown): asserts value is HistoryIdentity {
  requireThat(
    object(value) && isHistoryHost(value.host) && typeof value.id === "string" &&
    typeof value.sessionId === "string" && value.sessionId.length > 0,
    "历史归档身份无效。",
  );
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
  requireThat(
    object(value) && fields(value, rawFields) && typeof value.name === "string" &&
    Array.isArray(value.exchanges) && Array.isArray(value.branches),
    "历史原文归档无效。",
  );
  const ids = new Set<string>();
  for (const item of value.exchanges) {
    requireThat(exchange(item) && fields(item, exchangeFields) && item.entryIds.length > 0, "历史问答或其来源消息 ID 无效。");
    requireThat(item.id !== value.id && !ids.has(item.id), "历史问答 ID 重复：" + item.id);
    ids.add(item.id);
  }
  for (const branch of value.branches) {
    requireThat(
      strings(branch) && new Set(branch).size === branch.length && branch.every(id => ids.has(id)),
      "历史分支包含重复或未知的问答 ID。",
    );
  }
  return value as unknown as RawHistory;
}

export function summaryArtifact(value: unknown, expectedDimension?: string): SummaryArtifact {
  requireThat(object(value) && fields(value, summaryArtifactFields), "历史摘要产物格式无效。");
  requireThat(typeof value.id === "string" && value.id.length > 0, "历史摘要 ID 无效。");
  fileId(value.id);
  requireThat(isSummaryDimension(value.dimension), "历史摘要维度无效。");
  if (expectedDimension !== undefined) {
    requireThat(value.dimension === expectedDimension, `历史摘要维度不匹配，预期 ${expectedDimension}，实际 ${value.dimension}。`);
  }
  if (value.host !== undefined) requireThat(isHistoryHost(value.host), "历史摘要来源 host 无效。");
  if (value.sessionId !== undefined) requireThat(typeof value.sessionId === "string" && value.sessionId.length > 0, "历史摘要 sessionId 无效。");
  requireThat(
    typeof value.title === "string" && typeof value.text === "string" && value.text.trim().length > 0 &&
    typeof value.from === "string" && typeof value.to === "string" && typeof value.updatedAt === "string",
    "历史摘要正文或时间字段无效。",
  );
  const source = value.source;
  requireThat(
    object(source) && fields(source, summarySourceFields) &&
    strings(source.rawIds) && source.rawIds.length > 0 &&
    strings(source.exchangeIds) &&
    typeof source.fingerprint === "string" && source.fingerprint.length > 0,
    "历史摘要来源指纹无效。",
  );
  return value as unknown as SummaryArtifact;
}
