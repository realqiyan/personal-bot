import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceRoot } from "../../../common/paths.js";
import { requireThat } from "../../../common/validation.js";
import type {
  HistorySummaryRequest,
  RawHistory,
  SummaryArtifact,
  SummaryDimension,
  SummaryPlanOptions,
  SummaryPlanResult,
  SummaryTask,
} from "../../../model/history.js";
import { historyBucketFromTimestamp, unknownHistoryBucket } from "../../../storage/history-files.js";

let cachedPrompt: string | undefined;
function systemPrompt(): string {
  cachedPrompt ??= readFileSync(join(resourceRoot, "prompts/history-monthly-summary.md"), "utf8");
  return cachedPrompt;
}

function fingerprintSessionSummaries(summaries: readonly SummaryArtifact[]): string {
  const hash = createHash("sha256");
  for (const item of summaries) {
    hash.update(JSON.stringify([item.id, item.title, item.from, item.to, item.source.fingerprint, item.text]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function monthSpan(summaries: readonly SummaryArtifact[]): { from: string; to: string } {
  const dates = summaries.flatMap(item => [item.from, item.to]).filter(Boolean).sort();
  return {
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
  };
}

function formatSessionSummaries(summaries: readonly SummaryArtifact[]): string {
  return summaries
    .map(item => {
      const header = [`会话 ID：${item.id}`];
      if (item.title) header.push(`标题：${item.title}`);
      if (item.host) header.push(`来源：${item.host}`);
      header.push(`时间：${item.from} — ${item.to}`);
      return `[${header.join(" | ")}]\n${item.text}`;
    })
    .join("\n\n");
}

/**
 * Monthly cross-session summary dimension (enabled only under history.layout: "monthly").
 * Aggregates per-session summaries grouped by UTC YYYY/MM into one monthly artifact per month,
 * preserving source.rawIds for pbot_history drill-down to session summaries and raw exchanges.
 */
export const monthlySummaryDimension: SummaryDimension = {
  id: "monthly",
  title: "月度历史汇总",
  description: "按自然月（UTC YYYY/MM）归纳当月单会话摘要，提炼月度主题、关键决定与产出，支持逐层下钻。",
  requiresMonthlyLayout: true,

  plan(
    _raws: readonly RawHistory[],
    existing: ReadonlyMap<string, SummaryArtifact>,
    options: SummaryPlanOptions = {},
  ): SummaryPlanResult {
    const force = Boolean(options.force);
    const sessionMap = options.summariesByDimension?.get("session");
    if (!sessionMap || sessionMap.size === 0) return { tasks: [], skipped: 0 };

    const byMonth = new Map<string, SummaryArtifact[]>();
    for (const artifact of sessionMap.values()) {
      const bucket = historyBucketFromTimestamp(artifact.from || artifact.to);
      if (bucket === unknownHistoryBucket) continue;
      const monthId = bucket.replace("/", "-");
      const list = byMonth.get(monthId);
      if (list) list.push(artifact);
      else byMonth.set(monthId, [artifact]);
    }

    const tasks: SummaryTask[] = [];
    let skipped = 0;

    for (const [monthId, summaries] of byMonth) {
      const ordered = [...summaries].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
      const fingerprint = fingerprintSessionSummaries(ordered);
      const prev = existing.get(monthId);
      if (!force && prev && prev.source.fingerprint === fingerprint) {
        skipped++;
        continue;
      }
      const rawIds = [...new Set(ordered.flatMap(item => item.source.rawIds))];
      if (!rawIds.length) continue;
      const span = monthSpan(ordered);
      const [year, month] = monthId.split("-");
      tasks.push({
        id: monthId,
        dimension: this.id,
        mode: prev ? "rebuild" : "create",
        title: `${year}年${month}月历史汇总`,
        from: span.from,
        to: span.to,
        source: { rawIds, exchangeIds: [], fingerprint },
        exchanges: [],
        sourceSummaries: ordered,
        ...(prev ? { existing: prev } : {}),
      });
    }

    tasks.sort((a, b) => b.id.localeCompare(a.id));
    return { tasks, skipped };
  },

  buildRequest(task: SummaryTask): HistorySummaryRequest {
    const system = systemPrompt();
    const summaries = task.sourceSummaries ?? [];
    const prompt = [
      `月份：${task.id}（共 ${summaries.length} 个会话摘要）`,
      formatSessionSummaries(summaries),
    ].join("\n\n");
    return { system, prompt, maxTokens: 3072 };
  },

  finalize(task: SummaryTask, output: string, now: string): SummaryArtifact {
    const text = output.trim();
    requireThat(text.length > 0, "月度历史汇总为空。");
    return {
      id: task.id,
      dimension: this.id,
      title: task.title,
      text,
      from: task.from,
      to: task.to,
      updatedAt: now,
      source: task.source,
    };
  },
};
