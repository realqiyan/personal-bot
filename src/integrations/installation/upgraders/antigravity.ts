import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gte, lt, valid } from "semver";
import { object } from "../../../common/json.js";
import type { HostUpgradeContext, HostUpgradeResult, HostUpgrader } from "../../../model/installation.js";

async function readManifestVersion(path: string): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return object(data) && typeof data.version === "string" && valid(data.version) ? data.version : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const antigravityUpgrader: HostUpgrader = {
  host: "antigravity",
  async upgrade(context: HostUpgradeContext): Promise<HostUpgradeResult> {
    if (context.currentVersion && valid(context.currentVersion) && gte(context.currentVersion, context.targetVersion)) {
      return {
        host: this.host,
        state: "up-to-date",
        previousVersion: context.currentVersion,
        version: context.currentVersion,
        scope: "user",
        detail: "已是最新版本。",
      };
    }
    const pluginDir = join(context.packageRoot, "lib", "antigravity-plugin");
    const bundledVersion = await readManifestVersion(join(pluginDir, "plugin.json"));
    if (!bundledVersion) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: `缺少 Antigravity 插件构建产物：${pluginDir}`,
      };
    }
    if (lt(bundledVersion, context.targetVersion)) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: `当前本地包产物版本为 ${bundledVersion}，低于目标版本 ${context.targetVersion}；请先更新全局 personal-bot 包。`,
      };
    }
    const agy = context.env.PBOT_AGY_COMMAND || await context.findExecutable("agy");
    if (!agy) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: "未找到 Antigravity CLI（agy），已跳过。",
      };
    }
    await context.run(agy, ["plugin", "install", pluginDir], context.workspace);
    return {
      host: this.host,
      state: "updated",
      ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
      version: bundledVersion,
      scope: "user",
      detail: `已通过 agy plugin install 更新到 ${bundledVersion}。`,
      nextStep: "重启 Antigravity 会话使新版本生效。",
    };
  },
};
