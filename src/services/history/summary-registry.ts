import { requireThat } from "../../common/validation.js";
import type { SummaryDimension } from "../../model/history.js";
import { isSummaryDimension } from "../../storage/history-format.js";
import { sessionSummaryDimension } from "./summary-dimensions/session.js";

const registry = new Map<string, SummaryDimension>([
  [sessionSummaryDimension.id, sessionSummaryDimension],
]);

/** Register a custom summary dimension (e.g. daily, decisions, topics). */
export function registerSummaryDimension(dimension: SummaryDimension): void {
  requireThat(isSummaryDimension(dimension.id), "摘要维度 ID 无效：" + dimension.id);
  registry.set(dimension.id, dimension);
}

export function unregisterSummaryDimension(id: string): boolean {
  return registry.delete(id);
}

export function getSummaryDimension(id: string): SummaryDimension | undefined {
  return registry.get(id);
}

export function listSummaryDimensions(): SummaryDimension[] {
  return [...registry.values()];
}

export function resolveSummaryDimensions(ids?: readonly string[]): SummaryDimension[] {
  if (!ids || ids.length === 0) return listSummaryDimensions();
  const unique = [...new Set(ids)];
  return unique.map(id => {
    const found = registry.get(id);
    requireThat(found, `未知的摘要维度：${id}（可用：${[...registry.keys()].join(", ")}）。`);
    return found;
  });
}
