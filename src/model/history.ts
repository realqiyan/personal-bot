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
  /** Ordered paths observed in the native source. Legacy exchanges can have no known path. */
  branches: string[][];
}
export interface HistorySummary extends HistoryExchange {
  id: string;
  level: number;
  children: string[];
  ready: boolean;
}
export interface HistoryArchive {
  raw: RawHistory;
  /** Empty if absent; null if the derived file is unreadable. */
  summaries: HistorySummary[] | null;
}
export interface HistoryNode extends HistorySummary {
  kind: "session" | "exchange" | "summary";
  parents: string[];
}
/** Query view and legacy on-disk format. New writers persist raw exchanges and summaries separately. */
export interface HistoryRecord extends HistoryIdentity {
  name: string;
  nodes: HistoryNode[];
}
export type HistoryHost = "pi" | "dsh" | "claude";
export type HistoryLocation = { host: "pi"; directory: string; file?: string } |
  { host: "dsh"; sessionId?: string };
export interface HistorySource {
  readonly host: HistoryLocation["host"];
  scan(location: HistoryLocation, signal?: AbortSignal, excluded?: ReadonlySet<string>): Promise<{ sessions: HistorySession[]; warnings: string[] }>;
}
export interface HistorySummaryRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}
export type HistorySummarizer = (request: HistorySummaryRequest, signal: AbortSignal) => Promise<string>;
