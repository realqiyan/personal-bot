export type HistoryHost = string;

export interface HistoryExchange {
  entryIds: string[];
  text: string;
  from: string;
  to: string;
  completed: boolean;
}

export interface HistorySession {
  sessionId: string;
  name: string;
  branches: HistoryExchange[][];
  /** Earlier partial observations replaced along the same native branch or turn; never persisted. */
  supersededEntryIds?: string[];
}

export interface HistoryIdentity {
  host: HistoryHost;
  id: string;
  sessionId: string;
}

export interface RawHistory extends HistoryIdentity {
  name: string;
  /** One entry per archived exchange; array order does not describe a conversation. */
  exchanges: (HistoryExchange & { id: string })[];
  /** Ordered paths observed in the native source. */
  branches: string[][];
}

export interface SummarySource {
  rawIds: string[];
  exchangeIds: string[];
  fingerprint: string;
}

export interface SummaryArtifact {
  id: string;
  dimension: string;
  host?: HistoryHost;
  sessionId?: string;
  title: string;
  text: string;
  from: string;
  to: string;
  updatedAt: string;
  source: SummarySource;
}

export interface HistorySummaryRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export type HistorySummarizer = (request: HistorySummaryRequest, signal: AbortSignal) => Promise<string>;

export type SummaryTaskMode = "create" | "incremental" | "rebuild";

export interface SummaryTask {
  id: string;
  dimension: string;
  mode: SummaryTaskMode;
  title: string;
  host?: HistoryHost;
  sessionId?: string;
  from: string;
  to: string;
  source: SummarySource;
  exchanges: readonly (HistoryExchange & { id: string })[];
  existing?: SummaryArtifact;
  addedExchanges?: readonly (HistoryExchange & { id: string })[];
}

export interface SummaryPlanResult {
  tasks: SummaryTask[];
  skipped: number;
}

export interface SummaryDimension {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  plan(
    raws: readonly RawHistory[],
    existing: ReadonlyMap<string, SummaryArtifact>,
    options?: { force?: boolean },
  ): SummaryPlanResult;
  buildRequest(task: SummaryTask): HistorySummaryRequest;
  finalize(task: SummaryTask, output: string, now: string): SummaryArtifact;
}

export interface SummaryDimensionStatus {
  dimension: string;
  title: string;
  description: string;
  total: number;
  ready: number;
  pendingCreate: number;
  pendingIncremental: number;
  pendingRebuild: number;
}

export interface HistorySummaryReminder {
  rawCount: number;
  pendingCount: number;
  oldestRawAt: string;
  latestSummaryAt?: string;
  rawAgeDays: number;
  daysSinceLastSummary?: number;
  thresholdDays: number;
  message: string;
}

export interface SummaryRunProgress {
  dimension: string;
  completed: number;
  total: number;
  currentId: string;
  mode: SummaryTaskMode;
}

export interface SummaryDimensionReport {
  dimension: string;
  scanned: number;
  skipped: number;
  created: number;
  incremental: number;
  rebuilt: number;
  failed: { id: string; error: string }[];
}

export interface SummaryRunReport {
  dimensions: SummaryDimensionReport[];
  durationMs: number;
  warnings: string[];
}

export interface HistoryQuery {
  host?: HistoryHost;
  query?: string;
  sessionId?: string;
  dimension?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}
