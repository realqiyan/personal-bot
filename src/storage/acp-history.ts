import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryHost } from "../model/history.js";
import { readJsonFile } from "./atomic-json.js";
import { acpReference } from "./acp-files.js";

function memberDirectory(home: string, host: "pi" | "dsh") {
  if (host === "pi" && home.startsWith("file://")) return join(fileURLToPath(home), "pbot/subagents");
  const tilde = home === "~" || home.startsWith("~/") || ((host === "dsh" || process.platform === "win32") && home.startsWith("~\\"));
  return join(tilde ? join(homedir(), home.slice(2)) : home, "pbot/subagents");
}

/** A target session can be owned by either coordinator, even when its cwd belongs to another workspace. */
export function acpHistorySessions(directories: { pi?: string; dsh?: string }) {
  const ids: Record<HistoryHost, Set<string>> = { pi: new Set(), dsh: new Set(), claude: new Set() };
  const warnings: string[] = [];
  const warn = (path: string, error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(path + ": " + String(error));
  };
  const homes = { pi: process.env.PI_CODING_AGENT_DIR || "~/.pi/agent", dsh: process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : "~/.dsh" };
  for (const host of ["pi", "dsh"] as const) {
    let directory = directories[host];
    try {
      directory ??= memberDirectory(homes[host], host);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        try {
          const ref = readJsonFile(path, "acp-session.json", acpReference);
          if (ref.sessionId !== null) ids[ref.backend].add(ref.sessionId);
        } catch (error) { warn(path, error); }
      }
    } catch (error) { warn(directory ?? homes[host], error); }
  }
  return { ids, warnings };
}
