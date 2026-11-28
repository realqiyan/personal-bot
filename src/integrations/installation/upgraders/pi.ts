import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gte, valid } from "semver";
import { object } from "../../../common/json.js";
import { npmName } from "../../../common/package-source.js";
import type { HostUpgradeContext, HostUpgradeResult, HostUpgrader } from "../../../model/installation.js";

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (object(entry) && typeof entry.source === "string") return entry.source;
  return undefined;
}

async function hasCustomOnlySource(workspace: string): Promise<boolean> {
  const settingsPath = join(workspace, ".pi", "settings.json");
  try {
    const data: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!object(data) || !Array.isArray(data.packages)) return false;
    const sources = data.packages.map(packageSource).filter((value): value is string => value !== undefined);
    const matches = sources.filter(source => source.includes("personal-bot"));
    if (!matches.length) return false;
    return matches.every(source => npmName(source) !== "personal-bot");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readLocalPiVersion(workspace: string): Promise<string | undefined> {
  const manifestPath = join(workspace, ".pi", "npm", "node_modules", "personal-bot", "package.json");
  try {
    const data: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    return object(data) && data.name === "personal-bot" && typeof data.version === "string" && valid(data.version)
      ? data.version
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const piUpgrader: HostUpgrader = {
  host: "pi",
  async upgrade(context: HostUpgradeContext): Promise<HostUpgradeResult> {
    const current = await readLocalPiVersion(context.workspace) ?? context.currentVersion;
    if (current && valid(current) && gte(current, context.targetVersion)) {
      return {
        host: this.host,
        state: "up-to-date",
        previousVersion: current,
        version: current,
        scope: "local",
        detail: "已是最新版本。",
      };
    }
    if (await hasCustomOnlySource(context.workspace)) {
      return {
        host: this.host,
        state: "skipped",
        ...(current ? { previousVersion: current } : {}),
        scope: "local",
        detail: "工作区 Pi 配置中的 personal-bot 使用非 npm 自定义来源，已保留当前配置。",
      };
    }
    const pi = context.env.PBOT_PI_COMMAND || await context.findExecutable("pi");
    if (!pi) {
      return {
        host: this.host,
        state: "skipped",
        ...(current ? { previousVersion: current } : {}),
        scope: "local",
        detail: "未找到 Pi CLI（pi），已跳过。",
      };
    }
    await context.run(pi, ["install", "--local", `npm:personal-bot@${context.targetVersion}`], context.workspace);
    const installed = await readLocalPiVersion(context.workspace) ?? context.targetVersion;
    return {
      host: this.host,
      state: "updated",
      ...(current ? { previousVersion: current } : {}),
      version: installed,
      scope: "local",
      detail: `已通过 pi install --local 更新工作区 personal-bot 到 ${installed}。`,
      nextStep: "在 Pi 中执行 /reload 或重启 Pi 使新版本生效。",
    };
  },
};
