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

export const antigravityInstaller: HostInstaller = {
  host: "antigravity",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const agy = context.env.PBOT_AGY_COMMAND || await context.findExecutable("agy");
    if (!agy) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: "user",
        detail: "未找到 Antigravity CLI（agy）。请先安装 agy 后重试。",
      };
    }
    const pluginDir = join(context.packageRoot, "lib", "antigravity-plugin");
    const bundledVersion = await readManifestVersion(join(pluginDir, "plugin.json"));
    if (!bundledVersion) {
      return {
        host: this.host,
        state: "failed",
        scope: "user",
        detail: `缺少 Antigravity 插件构建产物：${pluginDir}。请先运行 npm run build。`,
      };
    }
    await context.run(agy, ["plugin", "install", pluginDir], context.workspace);
    return {
      host: this.host,
      state: "installed",
      version: bundledVersion,
      scope: "user",
      detail: `已通过 agy plugin install 安装 Antigravity 插件（${bundledVersion}）。`,
      nextStep: "在 Antigravity 目标工作区执行 /pbot init 启用 Personal Bot。",
    };
  },
};
