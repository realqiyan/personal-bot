import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceRoot } from "../../../common/paths.js";
import { requireThat } from "../../../common/validation.js";
import type {
  HistoryExchange,
  HistorySummaryRequest,
  RawHistory,
  SummaryArtifact,
  SummaryDimension,
  SummaryPlanResult,
  SummaryTask,
} from "../../../model/history.js";
import { fingerprintExchanges, orderedRawExchanges, rawSessionSpan, rawSessionTitle } from "../history-index.js";

let cachedPrompt: string | undefined;
function systemPrompt(): string {
  cachedPrompt ??= readFileSync(join(resourceRoot, "prompts/history-summary.md"), "utf8");
  return cachedPrompt;
}

function formatExchanges(exchanges: readonly (HistoryExchange & { id: string })[]): string {
  return exchanges
    .map(item => `[${item.from} — ${item.to}${item.completed ? "" : "；未完成"}]\n${item.text}`)
    .join("\n\n");
}

function isStrictUnchangedPrefix(
  existing: SummaryArtifact,
  ordered: readonly (HistoryExchange & { id: string })[],
): boolean {
  const prevIds = existing.source.exchangeIds;
  if (prevIds.length === 0 || prevIds.length >= ordered.length) return false;
  for (let i = 0; i < prevIds.length; i++) {
    if (ordered[i]!.id !== prevIds[i]) return false;
  }
  const prefixFingerprint = fingerprintExchanges(ordered.slice(0, prevIds.length));
  return prefixFingerprint === existing.source.fingerprint;
}

/**
 * Default per-session task summary dimension.
 * Produces one concise summary per raw session archive, supporting exact deduplication
 * (0 tokens on unchanged sessions) and rolling incremental updates when new turns are appended.
 */
export const sessionSummaryDimension: SummaryDimension = {
  id: "session",
  title: "会话任务摘要",
  description: "按单个会话提炼任务目标、关键决定、结果与未决事项，支持去重跳过与增量滚动更新。",

  plan(
    raws: readonly RawHistory[],
    existing: ReadonlyMap<string, SummaryArtifact>,
    options: { force?: boolean } = {},
  ): SummaryPlanResult {
    const force = Boolean(options.force);
    const tasks: SummaryTask[] = [];
    let skipped = 0;

    for (const raw of raws) {
      const ordered = orderedRawExchanges(raw);
      if (!ordered.length) continue;

      const exchangeIds = ordered.map(item => item.id);
      const fingerprint = fingerprintExchanges(ordered);
      const prev = existing.get(raw.id);

      if (!force && prev && prev.source.fingerprint === fingerprint) {
        skipped++;
        continue;
      }

      const span = rawSessionSpan(ordered);
      const title = rawSessionTitle(raw);
      const source = { rawIds: [raw.id], exchangeIds, fingerprint };

      if (!force && prev && isStrictUnchangedPrefix(prev, ordered)) {
        tasks.push({
          id: raw.id,
          dimension: this.id,
          mode: "incremental",
          title,
          host: raw.host,
          sessionId: raw.sessionId,
          from: span.from,
          to: span.to,
          source,
          exchanges: ordered,
          existing: prev,
          addedExchanges: ordered.slice(prev.source.exchangeIds.length),
        });
      } else {
        tasks.push({
          id: raw.id,
          dimension: this.id,
          mode: prev ? "rebuild" : "create",
          title,
          host: raw.host,
          sessionId: raw.sessionId,
          from: span.from,
          to: span.to,
          source,
          exchanges: ordered,
          ...(prev ? { existing: prev } : {}),
        });
      }
    }

    // Process most recently active sessions first.
    tasks.sort((a, b) => b.to.localeCompare(a.to) || a.id.localeCompare(b.id));
    return { tasks, skipped };
  },

  buildRequest(task: SummaryTask): HistorySummaryRequest {
    const system = systemPrompt();
    const heading = task.title ? [`会话标题：${task.title}`] : [];
    if (task.mode === "incremental" && task.existing && task.addedExchanges?.length) {
      const prompt = [
        ...heading,
        `【已有摘要（${task.existing.from} — ${task.existing.to}）】\n${task.existing.text}`,
        `【新增对话】\n${formatExchanges(task.addedExchanges)}`,
        "在已有摘要基础上合并新增对话，输出更新后的完整摘要：保留仍有效的事实，用新决定覆盖旧决定，去重并保持简洁。",
      ].join("\n\n");
      return { system, prompt, maxTokens: 2048 };
    }
    const prompt = [
      ...heading,
      formatExchanges(task.exchanges),
    ].join("\n\n");
    return { system, prompt, maxTokens: 2048 };
  },

  finalize(task: SummaryTask, output: string, now: string): SummaryArtifact {
    const text = output.trim();
    requireThat(text.length > 0, "历史摘要为空。");
    return {
      id: task.id,
      dimension: this.id,
      ...(task.host ? { host: task.host } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      title: task.title,
      text,
      from: task.from,
      to: task.to,
      updatedAt: now,
      source: task.source,
    };
  },
};
