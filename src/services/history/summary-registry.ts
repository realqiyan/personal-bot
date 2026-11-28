import { isHistoryIdentifier, requireThat } from "../../common/validation.js";
import type { HistoryLayout, SummaryDimension } from "../../model/history.js";
import { monthlySummaryDimension } from "./summary-dimensions/monthly.js";
import { sessionSummaryDimension } from "./summary-dimensions/session.js";

const registry = new Map<string, SummaryDimension>([
  [sessionSummaryDimension.id, sessionSummaryDimension],
  [monthlySummaryDimension.id, monthlySummaryDimension],
]);

/** Register a custom summary dimension (e.g. daily, decisions, topics). */
export function registerSummaryDimension(dimension: SummaryDimension): void {
  requireThat(isHistoryIdentifier(dimension.id), "摘要维度 ID 无效：" + dimension.id);
  registry.set(dimension.id, dimension);
}

export function unregisterSummaryDimension(id: string): boolean {
  return registry.delete(id);
}

export function getSummaryDimension(id: string): SummaryDimension | undefined {
  return registry.get(id);
}

export function listSummaryDimensions(layout?: HistoryLayout): SummaryDimension[] {
  const all = [...registry.values()];
  if (layout === "flat") return all.filter(dim => !dim.requiresMonthlyLayout);
  return all;
}

export function resolveSummaryDimensions(ids?: readonly string[], layout: HistoryLayout = "monthly"): SummaryDimension[] {
  if (!ids || ids.length === 0) return listSummaryDimensions(layout);
  const unique = [...new Set(ids)];
  return unique.map(id => {
    const found = registry.get(id);
    requireThat(found, `未知的摘要维度：${id}（可用：${[...registry.keys()].join(", ")}）。`);
    requireThat(
      !found.requiresMonthlyLayout || layout === "monthly",
      `摘要维度 ${id} 仅在年月目录布局（history.layout: "monthly"）下启用。`,
    );
    return found;
  });
}
