import type { HistoryLocation } from "../../model/history.js";
import type { HistoryService } from "../../services/history/history-service.js";
import type { HistoryInput } from "./contract.js";

export async function executeHistory(service: HistoryService, args: HistoryInput, location: HistoryLocation, signal?: AbortSignal) {
  signal?.throwIfAborted(); await service.refresh(location, signal); signal?.throwIfAborted();
  return args.action === "search" ? service.search(args) :
    { node: service.read(args.id!, args.offset, args.limit, args.childrenOffset, args.host), warnings: service.warnings };
}
