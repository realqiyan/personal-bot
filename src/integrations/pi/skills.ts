import { basename, dirname, join, matchesGlob, normalize, relative, resolve, sep } from "node:path";
import { getAgentDir, loadSkillsFromDir, parseArgs, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../../common/paths.js";

/** Dynamic resources follow the owning package's native include/exclude settings. */
export function workspaceSkillPaths(pi: ExtensionAPI, cwd: string): string[] {
  if (parseArgs(process.argv.slice(2)).noSkills) return [];
  const root = resolve(resourceRoot, ".."), origin = pi.getCommands().find(command => command.name === "pbot")?.sourceInfo;
  const files = loadSkillsFromDir({ dir: join(resourceRoot, "skills"), source: "pbot" }).skills.map(skill => skill.filePath);
  const posix = (path: string) => normalize(path).split(sep).join("/");
  const matches = (file: string, pattern: string, exact = false) => {
    const target = posix(pattern), parent = dirname(file);
    const paths = [relative(root, file), file, relative(root, parent), parent];
    if (!exact) paths.push(basename(file), basename(parent));
    return paths.some(path => exact ? posix(path) === target : matchesGlob(posix(path), target));
  };
  const own = (entry: string | { source: string }) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return source === origin?.source || [join(cwd, ".pi"), getAgentDir(), cwd].some(base => resolve(base, source) === root);
  };
  let entries = (pi.getSettings().packages ?? []).filter(own);
  if (origin?.origin === "package" && (!entries.length || entries.every(entry => typeof entry !== "string" && entry.autoload === false))) {
    const global = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
    entries = [...(global.packages ?? []).filter(own), ...entries];
  }
  let selected = new Set(entries.length && entries.every(entry => typeof entry !== "string" && entry.autoload === false) ? [] : files);
  for (const entry of entries) {
    if (typeof entry === "string" || entry.skills === undefined) continue;
    const patterns = entry.skills;
    if (entry.autoload === false) {
      for (const pattern of patterns) {
        const exact = /^[+-]/.test(pattern), target = pattern.replace(/^[!+-]/, "");
        for (const file of files.filter(file => matches(file, target, exact))) {
          if (/^[!-]/.test(pattern)) selected.delete(file); else selected.add(file);
        }
      }
      continue;
    }
    if (!patterns.length) { selected.clear(); continue; }
    const includes = patterns.filter(pattern => !/^[!+-]/.test(pattern));
    selected = new Set(files.filter(file => !includes.length || includes.some(pattern => matches(file, pattern))));
    for (const prefix of ["!", "+", "-"]) {
      for (const pattern of patterns.filter(pattern => pattern.startsWith(prefix))) {
        for (const file of files.filter(file => matches(file, pattern.slice(1), prefix !== "!"))) {
          if (prefix === "+") selected.add(file); else selected.delete(file);
        }
      }
    }
  }
  return [...selected];
}
