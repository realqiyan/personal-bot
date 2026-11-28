import type { HostInstallContext, HostInstaller, HostInstallResult } from "../../../model/installation.js";

export const dshInstaller: HostInstaller = {
  host: "dsh",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const profile = context.options.dshProfile || "pbot";
    const dsh = context.env.PBOT_DSH_COMMAND || await context.findExecutable("dsh");
    if (!dsh) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: `profile:${profile}`,
        detail: "未找到 dsh CLI（dsh）。请先安装 @deepseek-ai/dsh 后重试。",
      };
    }
    await context.run(dsh, ["plugin", "--profile", profile, "add", "personal-bot@latest"], context.workspace);
    return {
      host: this.host,
      state: "installed",
      scope: `profile:${profile}`,
      detail: `已通过 dsh plugin --profile ${profile} add 安装 personal-bot。`,
      nextStep: `启动 dsh --profile ${profile} 并在工作区执行 /pbot init 启用 Personal Bot。`,
    };
  },
};
