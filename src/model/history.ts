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
export interface HistoryNode extends HistoryExchange {
  id: string;
  kind: "session" | "exchange" | "summary";
  level: number;
  children: string[];
  parents: string[];
  ready: boolean;
}
export interface HistoryRecord {
  host: HistoryHost;
  id: string;
  sessionId: string;
  name: string;
  nodes: HistoryNode[];
}
export type HistoryHost = "pi" | "dsh" | "claude";
export type HistoryLocation = { host: "pi"; directory: string; file?: string } |
  { host: "dsh"; sessionId?: string };
export interface HistorySource {
  readonly host: HistoryLocation["host"];
  scan(location: HistoryLocation, signal?: AbortSignal): Promise<{ sessions: HistorySession[]; warnings: string[] }>;
}
export interface HistorySummaryRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}
export type HistorySummarizer = (request: HistorySummaryRequest, signal: AbortSignal) => Promise<string>;
