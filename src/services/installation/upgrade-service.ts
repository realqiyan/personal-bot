import { valid } from "semver";
import { requireThat } from "../../common/validation.js";
import type {
  CliUpgradeSummary,
  HostUpgradeContext,
  HostUpgradeResult,
  HostUpgrader,
  WorkspaceUpgradeSummary,
} from "../../model/installation.js";

export interface UpgradeArgs {
  help: boolean;
  workspace?: string;
  version?: string;
  hosts?: string[];
  dshProfile?: string;
  json: boolean;
}

export interface WorkspaceUpgradeTarget {
  host: string;
  currentVersion?: string;
  bindingPath?: string;
}

export const upgradeUsage =
  "用法：pbot upgrade|update [--workspace <目录>] [--version <MAJOR.MINOR.PATCH>] [--hosts <h1,h2>] [--dsh-profile <名称>] [--json]\n" +
  "将全局 CLI 与当前工作区已绑定的各宿主插件统一升级到 npm 最新稳定版（或指定版本）。";

export function parseUpgradeArgs(args: readonly string[]): UpgradeArgs {
  let workspace: string | undefined;
  let version: string | undefined;
  let hosts: string[] | undefined;
  let dshProfile: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--help" || token === "-h") return { help: true, json: false };
    if (token === "--json") { json = true; continue; }
    if (token === "--workspace" || token.startsWith("--workspace=")) {
      requireThat(workspace === undefined, "--workspace 只能指定一次。");
      workspace = token === "--workspace" ? args[++index] : token.slice("--workspace=".length);
      requireThat(workspace && !workspace.startsWith("-"), "--workspace 需要目录。");
      continue;
    }
    if (token === "--version" || token.startsWith("--version=")) {
      requireThat(version === undefined, "--version 只能指定一次。");
      version = token === "--version" ? args[++index] : token.slice("--version=".length);
      requireThat(version && valid(version) && /^[0-9]/.test(version) && version === version.trim(),
        "--version 需要合法的 MAJOR.MINOR.PATCH 版本号。");
      continue;
    }
    if (token === "--hosts" || token.startsWith("--hosts=")) {
      requireThat(hosts === undefined, "--hosts 只能指定一次。");
      const raw = token === "--hosts" ? args[++index] : token.slice("--hosts=".length);
      requireThat(raw && !raw.startsWith("-"), "--hosts 需要逗号分隔的宿主名称。");
      hosts = [...new Set(raw.split(",").map(item => item.trim()).filter(Boolean))];
      requireThat(hosts.length > 0, "--hosts 不能为空。");
      continue;
    }
    if (token === "--dsh-profile" || token.startsWith("--dsh-profile=")) {
      requireThat(dshProfile === undefined, "--dsh-profile 只能指定一次。");
      dshProfile = token === "--dsh-profile" ? args[++index] : token.slice("--dsh-profile=".length);
      requireThat(dshProfile && !dshProfile.startsWith("-"), "--dsh-profile 需要 profile 名称。");
      continue;
    }
    throw new Error(`不支持的参数：${token}\n${upgradeUsage}`);
  }
  return {
    help: false,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(hosts !== undefined ? { hosts } : {}),
    ...(dshProfile !== undefined ? { dshProfile } : {}),
    json,
  };
}

export async function executeWorkspaceUpgrade(
  input: {
    workspaceRoot: string;
    targetVersion: string;
    cli: CliUpgradeSummary;
    targets: readonly WorkspaceUpgradeTarget[];
    resolveUpgrader: (host: string) => HostUpgrader | undefined;
    createContext: (target: WorkspaceUpgradeTarget) => HostUpgradeContext;
    onResult?: (result: HostUpgradeResult) => void;
    signal: AbortSignal;
  },
): Promise<WorkspaceUpgradeSummary> {
  const results: HostUpgradeResult[] = [];
  for (const target of input.targets) {
    input.signal.throwIfAborted();
    const upgrader = input.resolveUpgrader(target.host);
    let result: HostUpgradeResult;
    if (!upgrader) {
      result = {
        host: target.host,
        state: "skipped",
        ...(target.currentVersion ? { previousVersion: target.currentVersion } : {}),
        detail: "未注册该宿主的自动升级适配器，已跳过。",
      };
    } else {
      try {
        result = await upgrader.upgrade(input.createContext(target));
      } catch (error) {
        input.signal.throwIfAborted();
        result = {
          host: target.host,
          state: "failed",
          ...(target.currentVersion ? { previousVersion: target.currentVersion } : {}),
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    results.push(result);
    input.onResult?.(result);
  }
  const ok = input.cli.state !== "failed" && !results.some(item => item.state === "failed");
  return {
    workspaceRoot: input.workspaceRoot,
    targetVersion: input.targetVersion,
    cli: input.cli,
    results,
    ok,
  };
}
