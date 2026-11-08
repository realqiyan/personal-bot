import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object } from "../../common/json.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";

function config(value: unknown): Record<string, unknown> {
  if (!object(value) || value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("配置必须是 JSON 对象，enabled 必须是布尔值。");
  }
  return value;
}
import type { WorkspaceConfig, WorkspaceConfiguration } from "../../model/workspace-config.js";

export function workspaceConfigPath(root: string): string {
  return join(root, ".pbot", "config.json");
}

/** Read only this workspace's configuration; parent directories never grant activation. */
export async function readWorkspaceConfig(root: string): Promise<WorkspaceConfiguration> {
  const path = workspaceConfigPath(root);
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, present: false, enabled: false };
    return { path, present: true, enabled: false, error: `无法读取工作区配置 ${path}: ${String(error)}` };
  }
  try {
    const value = config(JSON.parse(content));
    return { path, present: true, enabled: (value as WorkspaceConfig).enabled === true };
  } catch (error) {
    return { path, present: true, enabled: false, error: `工作区配置无效 ${path}: ${String(error)}` };
  }
}

/** Explicit init opts in this workspace while preserving its other configuration fields. */
export async function initializeWorkspaceConfig(root: string): Promise<void> {
  const current = await readWorkspaceConfig(root);
  if (current.error) throw new Error(current.error);
  if (current.enabled) return;
  const directory = dirname(current.path);
  await mkdir(directory, { recursive: true });
  const value = current.present ? readJsonFile(directory, "config.json", config) : {};
  const written = writeJsonFile(directory, "config.json", { ...value, enabled: true }, config, !current.present);
  if (!written) await initializeWorkspaceConfig(root);
}

export function workspaceDisabledMessage(configuration: WorkspaceConfiguration): string {
  return configuration.error ?? `Personal Bot 未在此工作区启用。请执行 /pbot init 初始化并启用；配置文件：${configuration.path}`;
}
