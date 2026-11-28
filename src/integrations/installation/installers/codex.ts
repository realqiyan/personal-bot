import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { valid } from "semver";
import { object } from "../../../common/json.js";
import type { HostInstallContext, HostInstaller, HostInstallResult } from "../../../model/installation.js";

async function readManifestVersion(path: string): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return object(data) && typeof data.version === "string" && valid(data.version) ? data.version : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const codexInstaller: HostInstaller = {
  host: "codex",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const codex = context.env.PBOT_CODEX_COMMAND || await context.findExecutable("codex");
    if (!codex) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: "user",
        detail: "未找到 Codex CLI（codex）。请先安装 Codex CLI 后重试。",
      };
    }
    const marketplaceDir = join(context.packageRoot, "lib", "codex-marketplace");
    const bundledVersion = await readManifestVersion(
      join(marketplaceDir, "plugins", "personal-bot", ".codex-plugin", "plugin.json"),
    );
    if (!bundledVersion) {
      return {
        host: this.host,
        state: "failed",
        scope: "user",
        detail: `缺少 Codex 插件构建产物：${marketplaceDir}。请先运行 npm run build。`,
      };
    }
    try {
      await context.run(codex, ["plugin", "marketplace", "add", marketplaceDir], context.workspace);
    } catch {
      // Marketplace may already be registered; proceed to install the plugin from it.
    }
    await context.run(codex, ["plugin", "add", "personal-bot@pbot-local"], context.workspace);
    return {
      host: this.host,
      state: "installed",
      version: bundledVersion,
      scope: "user",
      detail: `已通过 codex plugin add 安装 Codex 插件（${bundledVersion}）。`,
      nextStep: "在 Codex 的 /hooks 中核对并信任 Personal Bot hooks，然后执行 pbot plugin codex init 启用工作区。",
    };
  },
};
