import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { object } from "../../common/json.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { releaseLine } from "../../common/version.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";

function bindingDirectory(root: string) {
  const key = createHash("sha256").update(root).digest("hex");
  return join(homedir(), ".pbot", "workspaces", key);
}

// Full plugins own a local manifest. Thin clients can supply the release stamped into their cached hooks.
function pluginBinding(value: unknown): string {
  requireThat(typeof value === "string", "无效的插件安装记录。");
  if (!isAbsolute(value)) releaseLine(value);
  return value;
}

function permissionDenied(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Each host owns its file, including when two hosts activate the same canonical workspace concurrently. */
export function bindWorkspacePlugin(root: string, host: string, binding = resolve(resourceRoot, "../package.json")): void {
  const directory = bindingDirectory(root);
  const file = encodeURIComponent(host) + ".json";
  try {
    if (readJsonFile(directory, file, pluginBinding) === binding) return;
  } catch (error) {
    if (permissionDenied(error)) return;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJsonFile(directory, file, binding, pluginBinding);
  } catch (error) {
    if (!permissionDenied(error)) throw error;
  }
}

export function workspacePluginReleases(root: string): Record<string, string> {
  const directory = bindingDirectory(root);
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || permissionDenied(error)) return {};
    throw error;
  }
  const releases: Record<string, string> = Object.create(null);
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const host = decodeURIComponent(file.slice(0, -5));
    try {
      const binding = readJsonFile(directory, file, pluginBinding);
      if (!isAbsolute(binding)) { releases[host] = binding; continue; }
      const manifest: unknown = JSON.parse(readFileSync(binding, "utf8"));
      requireThat(object(manifest) && typeof manifest.version === "string", "无效的插件安装清单：" + binding);
      releaseLine(manifest.version);
      releases[host] = manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !permissionDenied(error)) throw error;
    }
  }
  return releases;
}
