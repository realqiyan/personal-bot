import { gte, valid } from "semver";
import type { HostUpgradeContext, HostUpgradeResult, HostUpgrader } from "../../../model/installation.js";

export function inferDshProfile(bindingPath?: string): string | undefined {
  if (!bindingPath) return undefined;
  const normalized = bindingPath.replaceAll("\\", "/");
  const match = /\/profiles\/([^/]+)\/node_modules\/personal-bot\/package\.json$/.exec(normalized);
  return match?.[1];
}

export const dshUpgrader: HostUpgrader = {
  host: "dsh",
  async upgrade(context: HostUpgradeContext): Promise<HostUpgradeResult> {
    if (context.currentVersion && valid(context.currentVersion) && gte(context.currentVersion, context.targetVersion)) {
      return {
        host: this.host,
        state: "up-to-date",
        previousVersion: context.currentVersion,
        version: context.currentVersion,
        detail: "已是最新版本。",
      };
    }
    const profile = context.options.dshProfile || inferDshProfile(context.bindingPath);
    if (!profile) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        detail: "无法自动识别 dsh profile；请传入 --dsh-profile <名称> 或手动执行：dsh plugin --profile <名称> update personal-bot --latest",
      };
    }
    const dsh = context.env.PBOT_DSH_COMMAND || await context.findExecutable("dsh");
    if (!dsh) {
      return {
        host: this.host,
        state: "skipped",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        scope: `profile:${profile}`,
        detail: "未找到 dsh CLI（dsh），已跳过。",
      };
    }
    try {
      await context.run(dsh, ["plugin", "--profile", profile, "update", "personal-bot", "--latest"], context.workspace);
    } catch (error) {
      return {
        host: this.host,
        state: "failed",
        ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
        scope: `profile:${profile}`,
        detail: `${error instanceof Error ? error.message : String(error)}（提示：更新 dsh 插件前需先停止对应 profile 的 dsh 服务）`,
      };
    }
    return {
      host: this.host,
      state: "updated",
      ...(context.currentVersion ? { previousVersion: context.currentVersion } : {}),
      version: context.targetVersion,
      scope: `profile:${profile}`,
      detail: `已更新 dsh profile "${profile}" 中的 personal-bot。`,
      nextStep: `重新启动 dsh --profile ${profile} 使新版本生效。`,
    };
  },
};
