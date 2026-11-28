import { requireThat } from "../../common/validation.js";
import type {
  HostInstallContext,
  HostInstaller,
  HostInstallResult,
  WorkspaceInstallSummary,
} from "../../model/installation.js";

export interface InstallArgs {
  help: boolean;
  target?: string;
  workspace?: string;
  dshProfile?: string;
  json: boolean;
}

export function formatInstallUsage(hosts: readonly string[]): string {
  return (
    `用法：pbot install <${hosts.join("|")}|all> [--workspace <目录>] [--dsh-profile <名称>] [--json]\n` +
    "为指定宿主安装 Personal Bot 插件；传入 all 时为本机已安装的各宿主统一安装。"
  );
}

export function parseInstallArgs(args: readonly string[], hosts: readonly string[]): InstallArgs {
  const usage = formatInstallUsage(hosts);
  let target: string | undefined;
  let workspace: string | undefined;
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
    if (token === "--dsh-profile" || token.startsWith("--dsh-profile=")) {
      requireThat(dshProfile === undefined, "--dsh-profile 只能指定一次。");
      dshProfile = token === "--dsh-profile" ? args[++index] : token.slice("--dsh-profile=".length);
      requireThat(dshProfile && !dshProfile.startsWith("-"), "--dsh-profile 需要 profile 名称。");
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`不支持的参数：${token}\n${usage}`);
    }
    requireThat(target === undefined, `只能指定一个安装目标，收到多余参数：${token}\n${usage}`);
    target = token.trim().toLowerCase();
  }
  requireThat(target && target.length > 0, `缺少安装目标。\n${usage}`);
  requireThat(target === "all" || hosts.includes(target), `未知宿主：${target}。\n${usage}`);
  return {
    help: false,
    target,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(dshProfile !== undefined ? { dshProfile } : {}),
    json,
  };
}

export async function executeHostInstall(input: {
  workspaceRoot: string;
  target: string;
  hosts: readonly string[];
  resolveInstaller: (host: string) => HostInstaller | undefined;
  createContext: (host: string, explicit: boolean) => HostInstallContext;
  onResult?: (result: HostInstallResult) => void;
  signal: AbortSignal;
}): Promise<WorkspaceInstallSummary> {
  const explicit = input.target !== "all";
  const targets = explicit ? [input.target] : [...input.hosts];
  const results: HostInstallResult[] = [];
  for (const host of targets) {
    input.signal.throwIfAborted();
    const installer = input.resolveInstaller(host);
    let result: HostInstallResult;
    if (!installer) {
      result = {
        host,
        state: explicit ? "failed" : "skipped",
        detail: "未注册该宿主的安装适配器。",
      };
    } else {
      try {
        result = await installer.install(input.createContext(host, explicit));
      } catch (error) {
        input.signal.throwIfAborted();
        result = {
          host,
          state: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    results.push(result);
    input.onResult?.(result);
  }
  const ok = !results.some(item => item.state === "failed");
  return {
    workspaceRoot: input.workspaceRoot,
    target: input.target,
    results,
    ok,
  };
}
