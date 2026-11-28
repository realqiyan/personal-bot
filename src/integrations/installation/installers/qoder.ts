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

export const qoderInstaller: HostInstaller = {
  host: "qoder",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const qodercli = context.env.PBOT_QODER_COMMAND || await context.findExecutable("qodercli");
    if (!qodercli) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: "user",
        detail: "未找到 Qoder CLI（qodercli）。请先安装 Qoder CLI 后重试。",
      };
    }
    const pluginDir = join(context.packageRoot, "lib", "qoder-plugin");
    const bundledVersion = await readManifestVersion(join(pluginDir, ".qoder-plugin", "plugin.json"));
    if (!bundledVersion) {
      return {
        host: this.host,
        state: "failed",
        scope: "user",
        detail: `缺少 Qoder CLI 插件构建产物：${pluginDir}。请先运行 npm run build。`,
      };
    }
    await context.run(qodercli, ["plugin", "install", pluginDir], context.workspace);
    return {
      host: this.host,
      state: "installed",
      version: bundledVersion,
      scope: "user",
      detail: `已通过 qodercli plugin install 安装 Qoder CLI 插件（${bundledVersion}）。`,
      nextStep: "在目标工作区执行 pbot plugin qoder init 启用 Personal Bot。",
    };
  },
};
