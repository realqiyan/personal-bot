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

export const codexUpgrader: HostUpgrader = {
  host: "codex",
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
    const marketplaceDir = join(context.packageRoot, "lib", "codex-marketplace");
    const bundledVersion = await readManifestVersion(join(marketplaceDir, "plugins", "personal-bot", ".codex-plugin", "plugin.json"));
    if (!bundledVersion) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: `缺少 Codex 插件构建产物：${marketplaceDir}`,
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
    const codex = context.env.PBOT_CODEX_COMMAND || await context.findExecutable("codex");
    if (!codex) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: "未找到 Codex CLI（codex），已跳过。",
      };
    }
    try {
      await context.run(codex, ["plugin", "marketplace", "add", marketplaceDir], context.workspace);
    } catch {
      // Marketplace may already be registered; proceed to re-install the plugin from it.
    }
    await context.run(codex, ["plugin", "add", "personal-bot@pbot-local"], context.workspace);
    return {
      host: this.host,
      state: "updated",
      ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
      version: bundledVersion,
      scope: "user",
      detail: `已通过 codex plugin add 更新到 ${bundledVersion}。`,
      nextStep: "重启 Codex 会话；若 hooks 有变化，请在 Codex /hooks 中重新核对信任。",
    };
  },
};
