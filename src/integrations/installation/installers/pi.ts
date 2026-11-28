import { packageVersion } from "../../../common/version.js";
import type { HostInstallContext, HostInstaller, HostInstallResult } from "../../../model/installation.js";

export const piInstaller: HostInstaller = {
  host: "pi",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const pi = context.env.PBOT_PI_COMMAND || await context.findExecutable("pi");
    if (!pi) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: "local",
        detail: "未找到 Pi CLI（pi）。请先安装 Pi 后重试。",
      };
    }
    await context.run(pi, ["install", "--local", "npm:personal-bot"], context.workspace);
    return {
      host: this.host,
      state: "installed",
      version: packageVersion,
      scope: "local",
      detail: "已通过 pi install --local 安装工作区 personal-bot。",
      nextStep: "启动 Pi 并在工作区执行 /pbot init 启用 Personal Bot。",
    };
  },
};
