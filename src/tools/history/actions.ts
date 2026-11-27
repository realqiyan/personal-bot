import { readWorkspaceHistory, searchWorkspaceHistory } from "../../services/history/history-query.js";
import type { HistoryInput } from "./contract.js";

export function executeHistory(root: string, args: HistoryInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (args.action === "search") {
    return searchWorkspaceHistory(root, args);
  }
  const node = readWorkspaceHistory(root, args.id, args.offset, args.limit, args.childrenOffset, args.host);
  return { node, warnings: node.warnings };
}
