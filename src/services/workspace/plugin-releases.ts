import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { object } from "../../common/json.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { releaseLine } from "../../common/version.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";

function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?/.exec(value);
    return match
      ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? "" }
      : undefined;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return a.localeCompare(b);
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

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

export interface WorkspacePluginBinding {
  version: string;
  bindingPath?: string;
}

export interface WorkspacePluginDrift {
  outOfSync: boolean;
  highest?: string;
  lowest?: string;
  versions: Record<string, string>;
}

export function workspacePluginBindings(root: string): Record<string, WorkspacePluginBinding> {
  const directory = bindingDirectory(root);
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || permissionDenied(error)) return {};
    throw error;
  }
  const bindings: Record<string, WorkspacePluginBinding> = Object.create(null);
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const host = decodeURIComponent(file.slice(0, -5));
    try {
      const binding = readJsonFile(directory, file, pluginBinding);
      if (!isAbsolute(binding)) { bindings[host] = { version: binding }; continue; }
      const manifest: unknown = JSON.parse(readFileSync(binding, "utf8"));
      requireThat(object(manifest) && typeof manifest.version === "string", "无效的插件安装清单：" + binding);
      releaseLine(manifest.version);
      bindings[host] = { version: manifest.version, bindingPath: binding };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !permissionDenied(error)) throw error;
    }
  }
  return bindings;
}

export function workspacePluginReleases(root: string): Record<string, string> {
  const bindings = workspacePluginBindings(root);
  const releases: Record<string, string> = Object.create(null);
  for (const [host, entry] of Object.entries(bindings)) releases[host] = entry.version;
  return releases;
}

export function workspacePluginDrift(releases: Record<string, string>): WorkspacePluginDrift {
  let highest: string | undefined;
  let lowest: string | undefined;
  for (const version of Object.values(releases)) {
    if (!highest || compareSemver(version, highest) > 0) highest = version;
    if (!lowest || compareSemver(version, lowest) < 0) lowest = version;
  }
  return {
    outOfSync: Boolean(highest && lowest && highest !== lowest),
    ...(highest ? { highest } : {}),
    ...(lowest ? { lowest } : {}),
    versions: releases,
  };
}
