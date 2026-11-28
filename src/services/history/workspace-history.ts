import { join } from "node:path";
import type { HistoryHost } from "../../model/history.js";
import { HistoryFiles } from "../../storage/history-files.js";
import { readWorkspaceHistoryLayoutSync } from "../workspace/workspace-config.js";

export function workspaceHistoryFiles(root: string, host?: HistoryHost): HistoryFiles {
  return new HistoryFiles(join(root, ".pbot/history"), host, readWorkspaceHistoryLayoutSync(root));
}
