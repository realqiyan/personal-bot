import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InstalledPackage } from "../../services/installation/setup-service.js";
import { npmName } from "../../common/package-source.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
async function sdkAt(root: string): Promise<PiSdk> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error("不是支持的 Pi 安装。");
  return import(pathToFileURL(join(root, "dist/index.js")).href) as Promise<PiSdk>;
}
const sourceOf = (entry: unknown): string => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "source" in entry && typeof entry.source === "string") return entry.source;
  throw new Error("无效的 Pi packages 声明。");
};

export async function inspectPackages(root: string, workspace: string): Promise<InstalledPackage[]> {
  const sdk = await sdkAt(root), agentDir = sdk.getAgentDir();
  // Inspect project declarations as data only. This does not load extensions, execute
  // project npmCommand, grant project trust, or persist migrated settings.
  const settings = sdk.SettingsManager.fromStorage({ withLock(scope, read) {
    const file = scope === "global" ? join(agentDir, "settings.json") : join(workspace, sdk.CONFIG_DIR_NAME, "settings.json");
    let content: string | undefined;
    try { content = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (content !== undefined) {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`无效的 Pi 配置：${file}`);
      const packages = (value as { packages?: unknown }).packages;
      if (packages !== undefined) {
        if (!Array.isArray(packages)) throw new Error(`packages 必须是数组：${file}`);
        packages.forEach(sourceOf);
      }
    }
    if (read(content) !== undefined) throw new Error("安装检查不得修改 Pi 配置。");
  } }, { projectTrusted: true });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(item => `${item.scope}: ${item.error.message}`).join("\n"));
  const manager = new sdk.DefaultPackageManager({ cwd: workspace, agentDir, settingsManager: settings });
  const result: InstalledPackage[] = [];
  for (const pkg of manager.listConfiguredPackages()) {
    const entries = (pkg.scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [];
    const entry = entries.find(item => sourceOf(item) === pkg.source);
    let name = npmName(pkg.source), version: string | undefined;
    if (pkg.installedPath) {
      let file = pkg.installedPath;
      if ((await stat(file)).isDirectory()) file = join(file, "package.json");
      else file = ""; // Single-file extensions have no npm identity.
      if (file) {
        try {
          const manifest = JSON.parse(await readFile(file, "utf8")) as { name?: string; version?: string };
          if (name && manifest.name !== name) throw new Error(`安装包身份不匹配：${pkg.source}`);
          name = typeof manifest.name === "string" ? manifest.name : name;
          version = typeof manifest.version === "string" ? manifest.version : undefined;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    result.push({ source: pkg.source, scope: pkg.scope, filtered: pkg.filtered, entry,
      ...(pkg.installedPath ? { installedPath: pkg.installedPath } : {}), ...(name ? { name } : {}), ...(version ? { version } : {}) });
  }
  return result;
}

export async function replaceProjectSource(root: string, workspace: string, old: InstalledPackage, target: string): Promise<void> {
  const fromProject = old.scope === "project" && !npmName(old.source);
  const fromUser = old.scope === "user" && !!npmName(old.source);
  if (!fromProject && !fromUser) throw new Error("此操作只替换工作区自定义来源，或继承全局 npm 资源过滤。");
  const sdk = await sdkAt(root);
  const settings = sdk.SettingsManager.create(workspace, sdk.getAgentDir(), { projectTrusted: true });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(item => item.error.message).join("\n"));
  const packages = settings.getProjectSettings().packages ?? [];
  const originals = fromProject ? packages : settings.getGlobalSettings().packages ?? [];
  const previous = originals.find(entry => sourceOf(entry) === old.source);
  if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(old.entry)) throw new Error("插件配置已发生变化，请重新运行 setup。");
  if (!packages.some(entry => sourceOf(entry) === target)) throw new Error("目标包尚未安装，保留原声明。");
  const manager = new sdk.DefaultPackageManager({ cwd: workspace, agentDir: sdk.getAgentDir(), settingsManager: settings });
  const installed = manager.getInstalledPath(target, "project");
  if (!installed || !npmName(target)) throw new Error("目标 npm 包尚未安装，保留原声明。");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (manifest.name !== npmName(target)) throw new Error("目标安装包身份不符，保留原声明。");
  // Change only declarations; do not call remove(), which deletes managed git caches.
  const replacement = typeof previous === "string" ? target : { ...previous, source: target };
  const next = fromProject
    ? packages.filter(entry => sourceOf(entry) !== target).map(entry => sourceOf(entry) === old.source ? replacement : entry)
    : packages.map(entry => sourceOf(entry) === target ? replacement : entry);
  settings.setProjectPackages(next);
  await settings.flush();
  const failures = settings.drainErrors();
  if (failures.length) throw new Error(failures.map(item => item.error.message).join("\n"));
}

async function main() {
  const [action, root, workspace, input] = process.argv.slice(2);
  if (!root || !workspace) throw new Error("缺少 Pi 路径或工作区。");
  if (action === "inspect") console.log(JSON.stringify(await inspectPackages(root, workspace)));
  else if (action === "replace" && input) {
    const { old, target } = JSON.parse(input) as { old: InstalledPackage; target: string };
    await replaceProjectSource(root, workspace, old, target);
  } else throw new Error("无效的安装检查操作。");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
