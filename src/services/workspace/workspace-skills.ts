import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSkillMeta } from "../../model/workspace-mcp.js";

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Parse YAML frontmatter fields (`name` and `description`) from a SKILL.md document. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const lines = match[1]!.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1]!;
    const raw = pair[2]!.trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const folded = raw.startsWith(">");
      const block: string[] = [];
      let indent: number | undefined;
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (!next.trim()) { block.push(""); i++; continue; }
        const leading = next.match(/^\s+/)?.[0].length ?? 0;
        if (leading === 0) break;
        indent ??= leading;
        block.push(next.slice(Math.min(indent, leading)).trimEnd());
        i++;
      }
      const joined = folded
        ? block.map(item => item.trim()).filter(Boolean).join(" ")
        : block.join("\n").trim();
      fields[key] = joined;
    } else if (raw) {
      fields[key] = unquoteYaml(raw);
    }
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
  };
}

/** Scan `<workspace>/.agents/skills/<dir>/SKILL.md` for workspace-authored skills. */
export async function discoverWorkspaceSkills(root: string): Promise<WorkspaceSkillMeta[]> {
  return discoverSkills(join(root, ".agents", "skills"), ".agents/skills");
}

export async function discoverSkills(skillsDir: string, indexPath: string): Promise<WorkspaceSkillMeta[]> {
  let entries;
  try { entries = await readdir(skillsDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: WorkspaceSkillMeta[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const filePath = join(skillsDir, entry.name, "SKILL.md");
    let content: string;
    try { content = await readFile(filePath, "utf8"); }
    catch { continue; }
    const meta = parseSkillFrontmatter(content);
    if (!meta?.name || !meta.description) continue;
    results.push({
      name: meta.name,
      description: meta.description,
      path: join(indexPath, entry.name, "SKILL.md"),
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}
