import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object } from "../../common/json.js";
import { acpPermissionPolicies } from "../../model/acp.js";
import { historyLayouts, summaryConcurrency } from "../../model/workspace-config.js";
import { isAcpBackend, isOneOf } from "../../common/validation.js";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";
import type {
  HistoryLayout,
  ResolvedWorkspaceFeatures,
  ResolvedWorkspaceHistoryConfig,
  ResolvedWorkspaceSummaryConfig,
  WorkspaceConfig,
  WorkspaceConfiguration,
  WorkspaceFeatures,
  WorkspaceHistoryConfig,
  WorkspaceSummaryConfig,
} from "../../model/workspace-config.js";

const featureKeys = ["prompts", "skills", "mcp", "history"] as const;
const summaryKeys = ["backend", "model", "thinking", "concurrency"] as const;
const historyKeys = ["layout"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function config(value: unknown): Record<string, unknown> {
  if (!object(value) || value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("配置必须是 JSON 对象，enabled 必须是布尔值。");
  }
  if (value.features !== undefined) {
    if (!object(value.features) ||
      Object.entries(value.features).some(([key, entry]) => !(featureKeys as readonly string[]).includes(key) || (entry !== undefined && typeof entry !== "boolean"))) {
      throw new Error("features 必须是 JSON 对象，仅支持 prompts、skills、mcp、history 布尔开关。");
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
        (command.permission !== undefined && !isOneOf(command.permission, acpPermissionPolicies)) ||
        Object.keys(command).some(key => !["command", "args", "env", "permission"].includes(key))) {
        throw new Error("ACP 配置需要 command（内置目标可省略）及可选 args 字符串数组、env 字符串映射、permission（ask、allow 或 deny）。");
      }
    }
  }
  if (value.summary !== undefined) {
    if (!object(value.summary) || Object.keys(value.summary).some(key => !(summaryKeys as readonly string[]).includes(key))) {
      throw new Error("summary 必须是 JSON 对象，仅支持 backend、model、thinking、concurrency。");
    }
    if (value.summary.backend !== undefined && !isAcpBackend(value.summary.backend)) {
      throw new Error("summary.backend 必须为小写字母、数字和连字符（1–64 字符）。");
    }
    if (value.summary.model !== undefined && !nonEmptyString(value.summary.model)) {
      throw new Error("summary.model 必须是非空字符串。");
    }
    if (value.summary.thinking !== undefined && !nonEmptyString(value.summary.thinking)) {
      throw new Error("summary.thinking 必须是非空字符串。");
    }
    if (value.summary.concurrency !== undefined &&
      (typeof value.summary.concurrency !== "number" || !Number.isInteger(value.summary.concurrency) || value.summary.concurrency < 1 || value.summary.concurrency > summaryConcurrency.max)) {
      throw new Error(`summary.concurrency 必须是 1 到 ${summaryConcurrency.max} 之间的整数。`);
    }
  }
  if (value.history !== undefined) {
    if (!object(value.history) || Object.keys(value.history).some(key => !(historyKeys as readonly string[]).includes(key))) {
      throw new Error("history 必须是 JSON 对象，仅支持 layout。");
    }
    if (value.history.layout !== undefined && !isOneOf(value.history.layout, historyLayouts)) {
      throw new Error('history.layout 必须是 "monthly" 或 "flat"。');
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
    history: raw?.history !== false,
  };
}

export function workspaceSummaryConfig(
  configuration?: Pick<WorkspaceConfiguration, "summary"> | WorkspaceSummaryConfig,
): ResolvedWorkspaceSummaryConfig {
  const raw: WorkspaceSummaryConfig | undefined = configuration && "summary" in configuration
    ? configuration.summary
    : configuration as WorkspaceSummaryConfig | undefined;
  return {
    backend: raw?.backend ?? "pi",
    ...(raw?.model ? { model: raw.model } : {}),
    ...(raw?.thinking ? { thinking: raw.thinking } : {}),
    concurrency: raw?.concurrency ?? summaryConcurrency.default,
  };
}

export function workspaceHistoryConfig(
  configuration?: Pick<WorkspaceConfiguration, "history"> | WorkspaceHistoryConfig,
): ResolvedWorkspaceHistoryConfig {
  const raw: WorkspaceHistoryConfig | undefined = configuration && "history" in configuration
    ? configuration.history
    : configuration as WorkspaceHistoryConfig | undefined;
  return {
    layout: raw?.layout === "flat" ? "flat" : "monthly",
  };
}

export function workspaceConfigPath(root: string): string {
  return join(root, ".pbot", "config.json");
}

/** Synchronous read of history.layout for storage and query callers; defaults to "monthly". */
export function readWorkspaceHistoryLayoutSync(root: string): HistoryLayout {
  const path = workspaceConfigPath(root);
  try {
    const content = readFileSync(path, "utf8");
    const parsed = config(JSON.parse(content)) as WorkspaceConfig;
    return workspaceHistoryConfig(parsed.history).layout;
  } catch {
    return "monthly";
  }
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
      ...(settings.summary ? { summary: settings.summary } : {}),
      ...(settings.history ? { history: settings.history } : {}),
    };
  } catch (error) {
    return { path, present: true, enabled: false, error: `工作区配置无效 ${path}: ${String(error)}` };
  }
}

/** Explicit init opts in this workspace while preserving its other configuration fields. */
export async function initializeWorkspaceConfig(root: string): Promise<void> {
  const current = await readWorkspaceConfig(root);
  if (current.error) throw new Error(current.error);
  const hasExplicitFeatures = featureKeys.every(key => typeof current.features?.[key] === "boolean");
  const hasExplicitSummary = typeof current.summary?.backend === "string" && typeof current.summary?.concurrency === "number";
  if (current.enabled && hasExplicitFeatures && hasExplicitSummary) return;
  const directory = dirname(current.path);
  await mkdir(directory, { recursive: true });
  const value = current.present ? readJsonFile(directory, "config.json", config) : {};
  const features = workspaceFeatures((value as WorkspaceConfig).features);
  const summary = workspaceSummaryConfig((value as WorkspaceConfig).summary);
  const written = writeJsonFile(directory, "config.json", { ...value, enabled: true, features, summary }, config, !current.present);
  if (!written) await initializeWorkspaceConfig(root);
}

export function workspaceDisabledMessage(configuration: WorkspaceConfiguration): string {
  return configuration.error ?? `Personal Bot 未在此工作区启用。请在工作区根目录运行 pbot init，也可在 Pi 或 dsh 中执行 /pbot init。配置文件位于 ${configuration.path}`;
}
