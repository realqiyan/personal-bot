import type { HostInstallContext, HostInstaller, HostInstallResult } from "../../../model/installation.js";

const claudeMarketplace = "realqiyan/personal-bot";

export const claudeInstaller: HostInstaller = {
  host: "claude",
  async install(context: HostInstallContext): Promise<HostInstallResult> {
    const claude = context.env.PBOT_CLAUDE_COMMAND || await context.findExecutable("claude");
    if (!claude) {
      return {
        host: this.host,
        state: context.explicit ? "failed" : "skipped",
        scope: "user",
        detail: "未找到 Claude Code CLI（claude）。请先安装 Claude Code 后重试。",
      };
    }
    await context.run(
      claude,
      ["plugin", "install", "personal-bot", "--marketplace", claudeMarketplace, "--yes"],
      context.workspace,
    );
    return {
      host: this.host,
      state: "installed",
      scope: "user",
      detail: `已通过 claude plugin install 从 ${claudeMarketplace} 安装 personal-bot。`,
      nextStep: "在 Claude Code 目标工作区执行 /personal-bot:pbot init 启用 Personal Bot。",
    };
  },
};
