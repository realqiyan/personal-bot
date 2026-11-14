import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Inspect only the native transcript belonging to this real-model fixture. */
export async function claudeRequests(sessionId, cwd) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, sessionId + ".jsonl");
    let content;
    try { content = await readFile(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const complete = content.slice(0, content.lastIndexOf("\n"));
    const rows = complete.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const header = rows.find(row => typeof row.cwd === "string");
    if (header?.cwd !== cwd) throw new Error("Claude transcript belongs to another workspace");
    return rows.filter(row => row.type === "api-request" && row.querySource === "sdk").map(row => ({
      model: row.params.model, thinking: row.params.output_config?.effort ?? "unset",
    }));
  }
  throw new Error("Claude native request transcript was not found");
}
