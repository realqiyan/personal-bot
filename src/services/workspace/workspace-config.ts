import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object } from "../../common/json.js";
import { isAcpBackend } from "../../common/validation.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";
import type { ResolvedWorkspaceFeatures, WorkspaceConfig, WorkspaceConfiguration, WorkspaceFeatures } from "../../model/workspace-config.js";

const featureKeys = ["prompts", "skills", "mcp"] as const;

function config(value: unknown): Record<string, unknown> {
  if (!object(value) || value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("配置必须是 JSON 对象，enabled 必须是布尔值。");
  }
  if (value.features !== undefined) {
    if (!object(value.features) ||
      Object.entries(value.features).some(([key, entry]) => !(featureKeys as readonly string[]).includes(key) || (entry !== undefined && typeof entry !== "boolean"))) {
      throw new Error("features 必须是 JSON 对象，仅支持 prompts、skills、mcp 布尔开关。");
    }
  }
  if (value.acp !== undefined) {
    if (!object(value.acp) || Object.keys(value.acp).some(key => !isAcpBackend(key))) {
      throw new Error("acp 键名必须为小写字母、数字和连字符（1–64 字符）。");
    }
    for (const command of Object.values(value.acp)) {
      // Without command, an entry keeps the registered default command and only sets env or permission.
      const launch = !object(command) ? false : command.command === undefined
        ? command.args === undefined
        : typeof command.command === "string" && command.command.trim() && !command.command.includes("\0") &&
          (command.args === undefined || (Array.isArray(command.args) && command.args.every(arg => typeof arg === "string" && !arg.includes("\0"))));
      if (!object(command) || !launch ||
        (command.env !== undefined && (!object(command.env) || Object.entries(command.env).some(([k, v]) => !k || k.includes("\0") || typeof v !== "string" || v.includes("\0")))) ||
        (command.permission !== undefined && !["ask", "allow", "deny"].includes(String(command.permission))) ||
        Object.keys(command).some(key => !["command", "args", "env", "permission"].includes(key))) {
        throw new Error("ACP 配置需要 command（内置目标可省略）及可选 args 字符串数组、env 字符串映射、permission（ask、allow 或 deny）。");
      }
    }
  }
  return value;
}

export function workspaceFeatures(configuration?: Pick<WorkspaceConfiguration, "features"> | WorkspaceFeatures): ResolvedWorkspaceFeatures {
  const raw: WorkspaceFeatures | undefined = configuration && "features" in configuration
    ? configuration.features
    : configuration as WorkspaceFeatures | undefined;
  return {
    prompts: raw?.prompts !== false,
    skills: raw?.skills !== false,
    mcp: raw?.mcp !== false,
  };
}

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
    const settings = value as WorkspaceConfig;
    return {
      path,
      present: true,
      enabled: settings.enabled === true,
      ...(settings.features ? { features: settings.features } : {}),
      ...(settings.acp ? { acp: settings.acp } : {}),
    };
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
