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
  id: string;
  sessionId: string;
  name: string;
  nodes: HistoryNode[];
}
export interface HistoryLocation { directory: string; file?: string }
export interface HistorySource {
  scan(location: HistoryLocation, signal?: AbortSignal): Promise<{ sessions: HistorySession[]; warnings: string[] }>;
}
export type HistorySummarizer = (text: string, signal: AbortSignal) => Promise<string>;
