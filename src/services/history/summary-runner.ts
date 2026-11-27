import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requireThat } from "../../common/validation.js";
import type {
  HistoryLayout,
  HistorySummarizer,
  HistorySummaryReminder,
  RawHistory,
  SummaryArtifact,
  SummaryDimensionReport,
  SummaryDimensionStatus,
  SummaryRunProgress,
  SummaryRunReport,
} from "../../model/history.js";
import { HistoryFiles } from "../../storage/history-files.js";
import { readWorkspaceHistoryLayoutSync } from "../workspace/workspace-config.js";
import { rawSessionSpan } from "./history-index.js";
import { resolveSummaryDimensions } from "./summary-registry.js";

const defaultConcurrency = 3;
const maxConcurrency = 8;
const lockRetryAttempts = 5;
const lockRetryDelayMs = 40;
export const defaultSummaryReminderDays = 7;
const dayMs = 24 * 60 * 60 * 1000;

async function withSummaryLockRetry<T>(
  files: HistoryFiles,
  dimension: string,
  operation: () => T,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return files.controlSummary(dimension, operation);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "PBOT_HISTORY_BUSY" && attempt < lockRetryAttempts - 1) {
        await delay(lockRetryDelayMs * (attempt + 1), undefined, { signal });
        continue;
      }
      throw error;
    }
  }
}

export interface InspectSummaryOptions {
  dimensions?: readonly string[];
  thresholdDays?: number;
  now?: Date;
}

export interface CheckSummaryReminderOptions {
  dimensions?: readonly string[];
  thresholdDays?: number;
  now?: Date;
}

function oldestRawTimestamp(raws: readonly RawHistory[]): number | undefined {
  let oldest: number | undefined;
  for (const raw of raws) {
    if (!raw.exchanges.length) continue;
    const { from } = rawSessionSpan(raw.exchanges);
    if (!from) continue;
    const parsed = Date.parse(from);
    if (Number.isNaN(parsed)) continue;
    if (oldest === undefined || parsed < oldest) oldest = parsed;
  }
  return oldest;
}

function latestSummaryTimestamp(artifacts: Iterable<SummaryArtifact>): number | undefined {
  let latest: number | undefined;
  for (const artifact of artifacts) {
    const parsed = Date.parse(artifact.updatedAt);
    if (Number.isNaN(parsed)) continue;
    if (latest === undefined || parsed > latest) latest = parsed;
  }
  return latest;
}

function evaluateSummaryReminder(
  raws: readonly RawHistory[],
  allSummaries: readonly SummaryArtifact[],
  pendingCount: number,
  options: { thresholdDays?: number; now?: Date } = {},
): HistorySummaryReminder | undefined {
  if (!raws.length || pendingCount <= 0) return undefined;
  const thresholdDays = options.thresholdDays ?? defaultSummaryReminderDays;
  requireThat(Number.isFinite(thresholdDays) && thresholdDays > 0, "历史摘要提醒天数必须大于 0。");
  const thresholdMs = thresholdDays * dayMs;
  const nowMs = (options.now ?? new Date()).getTime();
  const oldestRawMs = oldestRawTimestamp(raws);
  if (oldestRawMs === undefined || nowMs - oldestRawMs < thresholdMs) return undefined;

  const latestSummaryMs = latestSummaryTimestamp(allSummaries);
  if (latestSummaryMs !== undefined && nowMs - latestSummaryMs < thresholdMs) return undefined;

  const rawAgeDays = Math.floor((nowMs - oldestRawMs) / dayMs);
  const daysSinceLastSummary = latestSummaryMs === undefined ? undefined : Math.floor((nowMs - latestSummaryMs) / dayMs);
  const message = daysSinceLastSummary === undefined
    ? `历史原文已累计 ${rawAgeDays} 天（待摘要 ${pendingCount} 项），尚未触发过摘要整理；可运行 /pbot history summary 生成摘要。`
    : `历史原文已累计 ${rawAgeDays} 天，且已 ${daysSinceLastSummary} 天未触发摘要整理（待摘要 ${pendingCount} 项）；可运行 /pbot history summary 更新摘要。`;

  return {
    rawCount: raws.length,
    pendingCount,
    oldestRawAt: new Date(oldestRawMs).toISOString(),
    ...(latestSummaryMs !== undefined ? { latestSummaryAt: new Date(latestSummaryMs).toISOString() } : {}),
    rawAgeDays,
    ...(daysSinceLastSummary !== undefined ? { daysSinceLastSummary } : {}),
    thresholdDays,
    message,
  };
}

/** Read-only startup probe: reminds when raw history has existed >= thresholdDays and no summary ran within thresholdDays. */
export function checkHistorySummaryReminder(
  root: string,
  options: CheckSummaryReminderOptions = {},
): HistorySummaryReminder | undefined {
  const layout = readWorkspaceHistoryLayoutSync(root);
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", layout);
  const raws = files.listRaw();
  if (!raws.length) return undefined;

  const thresholdDays = options.thresholdDays ?? defaultSummaryReminderDays;
  requireThat(Number.isFinite(thresholdDays) && thresholdDays > 0, "历史摘要提醒天数必须大于 0。");
  const nowMs = (options.now ?? new Date()).getTime();
  const oldestRawMs = oldestRawTimestamp(raws);
  if (oldestRawMs === undefined || nowMs - oldestRawMs < thresholdDays * dayMs) return undefined;

  const dimensions = resolveSummaryDimensions(options.dimensions, layout);
  const seenDimensions = new Set<string>();
  const summariesByDimension = new Map<string, Map<string, SummaryArtifact>>();
  const allSummaries: SummaryArtifact[] = [];
  let pendingCount = 0;

  const loadDimension = (dimId: string) => {
    const cached = summariesByDimension.get(dimId);
    if (cached) return cached;
    const list = files.listSummaries(dimId);
    const map = new Map(list.map(item => [item.id, item]));
    summariesByDimension.set(dimId, map);
    return map;
  };

  for (const dimension of dimensions) {
    seenDimensions.add(dimension.id);
    if (dimension.id !== "session") loadDimension("session");
    const existing = loadDimension(dimension.id);
    allSummaries.push(...existing.values());
    const plan = dimension.plan(raws, existing, { force: false, summariesByDimension });
    pendingCount += plan.tasks.length;
  }

  for (const dim of files.listDimensions()) {
    if (seenDimensions.has(dim)) continue;
    allSummaries.push(...loadDimension(dim).values());
  }

  return evaluateSummaryReminder(raws, allSummaries, pendingCount, options);
}

/** Read-only inspection of raw archives vs derived summaries across requested dimensions. */
export function inspectWorkspaceSummaries(
  root: string,
  options: InspectSummaryOptions = {},
): { layout: HistoryLayout; rawCount: number; dimensions: SummaryDimensionStatus[]; warnings: string[]; reminder?: HistorySummaryReminder } {
  const layout = readWorkspaceHistoryLayoutSync(root);
  const files = new HistoryFiles(join(root, ".pbot/history"), "pi", layout);
  const raws = files.listRaw();
  const warnings = [...files.warnings];
  if (layout === "monthly") {
    const flatNotice = files.detectFlatFiles().message;
    if (flatNotice) warnings.push(flatNotice);
  }
  const dimensions = resolveSummaryDimensions(options.dimensions, layout);

  const statuses: SummaryDimensionStatus[] = [];
  const seenDimensions = new Set<string>();
  const summariesByDimension = new Map<string, Map<string, SummaryArtifact>>();
  const allSummaries: SummaryArtifact[] = [];
  let totalPending = 0;

  const loadDimension = (dimId: string) => {
    const cached = summariesByDimension.get(dimId);
    if (cached) return cached;
    const list = files.listSummaries(dimId);
    warnings.push(...files.warnings);
    const map = new Map(list.map(item => [item.id, item]));
    summariesByDimension.set(dimId, map);
    return map;
  };

  for (const dimension of dimensions) {
    seenDimensions.add(dimension.id);
    if (dimension.id !== "session") loadDimension("session");
    const existing = loadDimension(dimension.id);
    allSummaries.push(...existing.values());
    const plan = dimension.plan(raws, existing, { force: false, summariesByDimension });
    totalPending += plan.tasks.length;

    let pendingCreate = 0;
    let pendingIncremental = 0;
    let pendingRebuild = 0;
    for (const task of plan.tasks) {
      if (task.mode === "create") pendingCreate++;
      else if (task.mode === "incremental") pendingIncremental++;
      else pendingRebuild++;
    }
    statuses.push({
      dimension: dimension.id,
      title: dimension.title,
      description: dimension.description,
      total: plan.skipped + plan.tasks.length,
      ready: plan.skipped,
      pendingCreate,
      pendingIncremental,
      pendingRebuild,
    });
  }

  for (const dim of files.listDimensions()) {
    if (seenDimensions.has(dim)) continue;
    allSummaries.push(...loadDimension(dim).values());
  }

  const reminder = evaluateSummaryReminder(raws, allSummaries, totalPending, options);
  return {
    layout,
    rawCount: raws.length,
    dimensions: statuses,
    warnings: [...new Set(warnings)],
    ...(reminder ? { reminder } : {}),
  };
}

export interface RunSummaryOptions {
  root: string;
  summarizer: HistorySummarizer;
  dimensions?: readonly string[];
  force?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: SummaryRunProgress) => void;
}

/**
 * Trigger-agnostic summary execution engine.
 * Reads raw archives once, plans deduplicated incremental/full tasks per dimension,
 * executes LLM calls with bounded concurrency, and persists each artifact atomically.
 */
export async function runWorkspaceSummaries(options: RunSummaryOptions): Promise<SummaryRunReport> {
  const startedAt = Date.now();
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const concurrency = Math.max(1, Math.min(maxConcurrency, Math.floor(options.concurrency ?? defaultConcurrency)));
  const layout = readWorkspaceHistoryLayoutSync(options.root);
  const dimensions = resolveSummaryDimensions(options.dimensions, layout);
  const files = new HistoryFiles(join(options.root, ".pbot/history"), "pi", layout);

  const raws = files.listRaw();
  const warnings = [...files.warnings];
  if (layout === "monthly") {
    const flatNotice = files.detectFlatFiles().message;
    if (flatNotice) warnings.push(flatNotice);
  }
  const summariesByDimension = new Map<string, Map<string, SummaryArtifact>>();
  const reports: SummaryDimensionReport[] = [];

  for (const dimension of dimensions) {
    signal.throwIfAborted();
    if (dimension.id !== "session" && !summariesByDimension.has("session")) {
      const sessionList = files.listSummaries("session");
      warnings.push(...files.warnings);
      summariesByDimension.set("session", new Map(sessionList.map(item => [item.id, item])));
    }
    const existingList = files.listSummaries(dimension.id);
    warnings.push(...files.warnings);
    const existing = new Map(existingList.map(item => [item.id, item]));
    summariesByDimension.set(dimension.id, existing);
    const plan = dimension.plan(raws, existing, { force: Boolean(options.force), summariesByDimension });

    const report: SummaryDimensionReport = {
      dimension: dimension.id,
      scanned: dimension.id === "monthly" ? (summariesByDimension.get("session")?.size ?? 0) : raws.length,
      skipped: plan.skipped,
      created: 0,
      incremental: 0,
      rebuilt: 0,
      failed: [],
    };

    if (plan.tasks.length > 0) {
      let nextIndex = 0;
      let completed = 0;
      const total = plan.tasks.length;

      const worker = async () => {
        for (;;) {
          signal.throwIfAborted();
          const index = nextIndex++;
          if (index >= total) return;
          const task = plan.tasks[index]!;
          try {
            const request = dimension.buildRequest(task);
            const output = await options.summarizer(request, signal);
            signal.throwIfAborted();
            const artifact = dimension.finalize(task, output, new Date().toISOString());
            await withSummaryLockRetry(files, dimension.id, () => {
              signal.throwIfAborted();
              files.saveSummary(artifact);
            }, signal);
            existing.set(artifact.id, artifact);
            if (task.mode === "create") report.created++;
            else if (task.mode === "incremental") report.incremental++;
            else report.rebuilt++;
          } catch (error) {
            if (signal.aborted) throw error;
            report.failed.push({ id: task.id, error: error instanceof Error ? error.message : String(error) });
          } finally {
            completed++;
            if (!signal.aborted) {
              options.onProgress?.({
                dimension: dimension.id,
                completed,
                total,
                currentId: task.id,
                mode: task.mode,
              });
            }
          }
        }
      };

      const workerCount = Math.min(concurrency, total);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    reports.push(report);
  }

  requireThat(!signal.aborted, "历史摘要已取消。");
  return {
    dimensions: reports,
    durationMs: Date.now() - startedAt,
    warnings: [...new Set(warnings)],
  };
}
