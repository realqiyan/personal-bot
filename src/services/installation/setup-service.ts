import { npmName, ordinaryNpm } from "../../common/package-source.js";

export interface PluginSpec {
  id: string;
  label: string;
  description: string;
  source: string;
  defaultSelected: boolean;
}
export interface InstalledPackage {
  source: string;
  scope: "user" | "project";
  name?: string;
  version?: string;
  installedPath?: string;
  filtered: boolean;
  entry: unknown;
}
export interface PackageChoice {
  plugin: PluginSpec;
  required: boolean;
  existing: InstalledPackage[];
  selected: boolean;
  keep: boolean;
  target?: string;
  error?: string;
}
export interface PiInstallation { command: string; root: string; version: string }
export interface SystemCommand { command: string; args: string[] }
export interface SetupPlan {
  workspace: string;
  pi?: PiInstallation;
  piVersion: string;
  tmux?: SystemCommand;
  packages: PackageChoice[];
}
export interface SetupResult { name: string; state: "done" | "kept" | "skipped" | "failed"; detail: string }
export interface SetupOperations {
  installTmux(command: SystemCommand): Promise<void>;
  ensurePi(existing: PiInstallation | undefined, version: string): Promise<PiInstallation>;
  installPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string>;
  verifyKeptPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string>;
}

export const pbotPackage: PluginSpec = {
  id: "pbot", label: "Personal Bot", description: "工作区个人助手", source: "npm:personal-bot", defaultSelected: true,
};
export function parseCatalog(value: unknown): PluginSpec[] {
  if (!Array.isArray(value)) throw new Error("插件清单必须是数组。");
  const ids = new Set(["pbot"]), names = new Set(["personal-bot"]);
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("无效插件清单项。");
    const entry = item as Record<string, unknown>;
    for (const field of ["id", "label", "description", "source"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim() || /[\x00-\x1f\x7f]/.test(entry[field])) {
        throw new Error(`无效插件字段：${field}`);
      }
    }
    const plugin = entry as unknown as PluginSpec;
    const name = npmName(plugin.source);
    if (!/^[a-z0-9-]+$/.test(plugin.id) || !name || !ordinaryNpm(plugin.source) ||
      typeof plugin.defaultSelected !== "boolean" || ids.has(plugin.id) || names.has(name)) {
      throw new Error(`无效或重复的插件：${plugin.id}`);
    }
    ids.add(plugin.id); names.add(name);
    return { id: plugin.id, label: plugin.label, description: plugin.description,
      source: `npm:${name}`, defaultSelected: plugin.defaultSelected };
  });
}
export function packageChoices(catalog: PluginSpec[], installed: InstalledPackage[]): PackageChoice[] {
  const first = !installed.some(pkg => pkg.name === "personal-bot");
  return [pbotPackage, ...catalog].map(plugin => {
    const matches = installed.filter(pkg => pkg.name === npmName(plugin.source));
    // A project npm entry overrides the same npm identity in user settings. Different
    // git/local identities still need an explicit decision before changing sources.
    const localNpm = matches.some(pkg => pkg.scope === "project" && npmName(pkg.source));
    const existing = matches.filter(pkg => !(localNpm && pkg.scope === "user" && npmName(pkg.source)));
    const custom = existing.some(pkg => !ordinaryNpm(pkg.source));
    return { plugin, required: plugin.id === "pbot", existing,
      selected: plugin.id === "pbot" || (first ? plugin.defaultSelected : existing.length > 0), keep: custom };
  });
}
export function parseSetupArgs(args: string[]): { action: "help" | "version" | "setup"; workspace?: string } {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { action: "help" };
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) return { action: "version" };
  if (args[0] !== "setup") throw new Error("用法：pbot setup [--workspace <目录>]");
  let workspace: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "--help" || arg === "-h") && args.length === 2) return { action: "help" };
    if (arg !== "--workspace" || workspace !== undefined) throw new Error(`不支持的参数：${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--") || /[\x00-\x1f\x7f]/.test(value)) throw new Error("--workspace 需要目录。");
    workspace = value;
  }
  return workspace === undefined ? { action: "setup" } : { action: "setup", workspace };
}

export async function executeSetup(plan: SetupPlan, operations: SetupOperations,
  report: (result: SetupResult) => void, signal: AbortSignal): Promise<{ pi?: PiInstallation; results: SetupResult[] }> {
  const results: SetupResult[] = [];
  const add = (result: SetupResult) => { results.push(result); report(result); };
  let pi: PiInstallation;
  try {
    signal.throwIfAborted();
    if (plan.tmux) { await operations.installTmux(plan.tmux); add({ name: "tmux", state: "done", detail: "已安装" }); }
    signal.throwIfAborted();
    pi = await operations.ensurePi(plan.pi, plan.piVersion);
    add({ name: "Pi", state: "done", detail: pi.version });
  } catch (error) {
    signal.throwIfAborted();
    add({ name: "运行环境", state: "failed", detail: String(error) });
    return { results };
  }
  for (const choice of plan.packages) {
    signal.throwIfAborted();
    const name = choice.plugin.label;
    if (!choice.selected) { add({ name, state: "skipped", detail: "本次不处理" }); continue; }
    if (choice.error) {
      add({ name, state: "failed", detail: choice.error });
      if (choice.required) return { results };
      continue;
    }
    if (choice.keep) {
      try {
        const source = await operations.verifyKeptPackage(pi, plan.workspace, choice);
        add({ name, state: "kept", detail: source });
      } catch (error) {
        signal.throwIfAborted();
        add({ name, state: "failed", detail: String(error) });
        if (choice.required) return { results };
      }
      continue;
    }
    try {
      const version = await operations.installPackage(pi, plan.workspace, choice);
      add({ name, state: "done", detail: version });
    } catch (error) {
      signal.throwIfAborted();
      add({ name, state: "failed", detail: String(error) });
      if (choice.required) return { results };
    }
  }
  return { pi, results };
}
