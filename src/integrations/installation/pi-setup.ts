import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkStableVersion, npmName } from "../../common/package-source.js";
import type { InstalledPackage, PackageChoice, PiInstallation, SetupOperations, SystemCommand } from "../../services/installation/setup-service.js";
import { findExecutable, npmGlobalBinary, SetupProcesses } from "./processes.js";

export const piPackageName = "@earendil-works/pi-coding-agent";
export class PiBootstrapRequired extends Error {}
const bridge = fileURLToPath(new URL("./pi-bridge.js", import.meta.url));
const guard = fileURLToPath(new URL("../../extension/setup-guard.js", import.meta.url));

async function packageRoot(command: string, version: string, env: NodeJS.ProcessEnv): Promise<string> {
  const resolved = await realpath(command);
  let directory = dirname(resolved);
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === piPackageName && pkg.version === version) return directory;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const roots = [join(dirname(dirname(resolved)), "install"), env.PI_MANAGED_INSTALL_ROOT].filter((root): root is string => !!root);
  for (const root of roots) {
    try {
      // The native managed launcher resides beside install/. Only accept a matching
      // launcher, not an unrelated PI_MANAGED_INSTALL_ROOT inherited from another Pi.
      const launcher = await realpath(join(dirname(root), "bin/pi"));
      if (launcher !== resolved) continue;
      const current = (await readFile(join(root, "current-version"), "utf8")).trim();
      if (current !== version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(current)) continue;
      const candidate = join(root, "releases", current, "node_modules", piPackageName);
      const pkg = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      if (pkg.name === piPackageName && pkg.version === version) return candidate;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`无法定位 ${command} 对应的 Pi 包。请先按此 Pi 的原生安装方式修复，不会覆盖该命令。`);
}

export class PiSetup implements SetupOperations {
  constructor(readonly processes: SetupProcesses, readonly npm: string, readonly cwd: string) {}

  async inspectPi(command?: string): Promise<PiInstallation | undefined> {
    const executable = command ?? await findExecutable("pi", this.processes.env);
    if (!executable) return undefined;
    const version = await this.processes.run(executable, ["--version"], this.cwd);
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`PATH 中的 ${executable} 不是可识别的 Pi。`);
    return { command: executable, version, root: await packageRoot(executable, version, this.processes.env) };
  }

  async latest(name: string): Promise<string> {
    const text = await this.processes.run(this.npm, ["view", `${name}@latest`, "version", "engines", "--json",
      "--fetch-retries=0", "--fetch-timeout=15000"], this.cwd);
    const value = JSON.parse(text) as { version?: string; engines?: { node?: string } };
    if (typeof value.version !== "string") throw new Error(`无法取得 ${name} 的最新版本。`);
    return checkStableVersion(value.version, value.engines?.node);
  }

  async inspectPackages(pi: PiInstallation | undefined, workspace: string): Promise<InstalledPackage[]> {
    if (!pi) {
      // A fresh machine can be planned without loading a Pi SDK. Existing declarations
      // require Pi's own resolver; don't guess git cache paths or package identities.
      const agentDir = this.processes.env.PI_CODING_AGENT_DIR ?? join(this.processes.env.HOME ?? homedir(), ".pi/agent");
      for (const file of [join(agentDir, "settings.json"), join(workspace, ".pi/settings.json")]) {
        try {
          const settings: unknown = JSON.parse(await readFile(file, "utf8"));
          if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`无效的 Pi 配置：${file}`);
          const packages = (settings as { packages?: unknown }).packages;
          if (packages !== undefined && !Array.isArray(packages)) throw new Error(`packages 必须是数组：${file}`);
          if (Array.isArray(packages) && packages.length > 0) {
            throw new PiBootstrapRequired(`已有插件配置但未找到 Pi：${file}`);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return [];
    }
    const data = await this.processes.run(process.execPath, [bridge, "inspect", pi.root, workspace], this.cwd);
    return JSON.parse(data) as InstalledPackage[];
  }

  async installTmux(command: SystemCommand): Promise<void> {
    await this.processes.run(command.command, command.args, this.cwd, { interactive: true });
    const tmux = await findExecutable("tmux", this.processes.env);
    if (!tmux) throw new Error("tmux 安装后仍不在 PATH 中，请修复 PATH 后重试。");
    await this.processes.run(tmux, ["-V"], this.cwd);
  }

  async ensurePi(existing: PiInstallation | undefined, version: string): Promise<PiInstallation> {
    if (existing) {
      if (existing.version !== version) await this.processes.run(existing.command, ["update"], this.cwd, { interactive: true });
      const installed = await this.inspectPi(existing.command);
      if (!installed || installed.version !== version) throw new Error(`Pi 实际版本 ${installed?.version ?? "未知"} 与目标 ${version} 不同。请用原安装方式更新后重试。`);
      return installed;
    }
    const prefix = await this.processes.run(this.npm, ["prefix", "--global"], this.cwd);
    if (!prefix || !prefix.startsWith("/")) throw new Error("无法确定 npm 全局安装目录。");
    try { await access(prefix, constants.W_OK); }
    catch { throw new Error(`npm 全局目录不可写：${prefix}。请先配置当前用户的 npm prefix 或 Node.js 版本管理器。`); }
    await this.processes.run(this.npm, ["install", "--global", "--ignore-scripts", "--engine-strict",
      `${piPackageName}@${version}`], this.cwd, { interactive: true });
    const installed = await this.inspectPi(npmGlobalBinary(prefix));
    if (!installed || installed.version !== version) throw new Error("Pi 安装版本验证失败。");
    const onPath = await findExecutable("pi", this.processes.env);
    if (!onPath || await realpath(onPath) !== await realpath(installed.command)) {
      throw new Error(`Pi 已安装到 ${installed.command}，请把 ${join(prefix, "bin")} 加入 PATH 后重新运行 setup。`);
    }
    return installed;
  }

  async verifyKeptPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string> {
    const old = choice.existing[0];
    if (choice.existing.length !== 1 || !old) throw new Error("保留来源不可用或存在多份来源，请先通过 pi config 处理。");
    const current = (await this.inspectPackages(pi, workspace)).find(pkg => pkg.source === old.source && pkg.scope === old.scope);
    if (!current?.installedPath || current.name !== npmName(choice.plugin.source) || JSON.stringify(current.entry) !== JSON.stringify(old.entry)) {
      throw new Error("保留来源已变化或不可读取，请重新运行 setup。");
    }
    return current.source;
  }

  async installPackage(pi: PiInstallation, workspace: string, choice: PackageChoice): Promise<string> {
    const name = npmName(choice.plugin.source);
    if (!name || !choice.target) throw new Error("缺少目标包或目标版本。");
    // Re-read just before mutation so a stale plan cannot replace a changed source.
    const current = (await this.inspectPackages(pi, workspace)).filter(pkg => pkg.name === name);
    for (const old of choice.existing) {
      const actual = current.find(pkg => pkg.scope === old.scope && pkg.source === old.source);
      if (!actual || JSON.stringify(actual.entry) !== JSON.stringify(old.entry)) throw new Error(`${name} 配置已改变，请重新运行 setup。`);
    }
    if (current.some(pkg => !choice.existing.some(old => old.scope === pkg.scope && old.source === pkg.source) &&
      !(pkg.scope === "user" && npmName(pkg.source) && choice.existing.some(old => old.scope === "project" && npmName(old.source))))) {
      throw new Error(`${name} 出现新的来源，请重新运行 setup。`);
    }
    const otherSources = choice.existing.filter(pkg => !npmName(pkg.source));
    if (otherSources.length > 1 || otherSources.some(pkg => pkg.scope === "user")) {
      throw new Error("存在不同身份的全局来源或多份自定义来源。请先用 pi config 调整加载范围后重试。");
    }
    const globals = choice.existing.filter(pkg => pkg.scope === "user" && npmName(pkg.source));
    if (globals.length > 1 && globals.some(pkg => pkg.filtered)) throw new Error("存在多份全局 npm 资源过滤，请先用 pi config 调整后重试。");
    const template = otherSources[0] ?? globals.find(pkg => pkg.filtered);
    const target = `npm:${name}@latest`;
    await this.processes.run(pi.command, ["install", "--local", target], workspace, { interactive: true });
    const records = await this.inspectPackages(pi, workspace);
    const installed = records.find(pkg => pkg.scope === "project" && pkg.source === target);
    if (!installed?.installedPath || installed.version !== choice.target) {
      throw new Error(`${name} 实际版本 ${installed?.version ?? "未知"} 与目标 ${choice.target} 不同，请检查 registry 后重试。`);
    }
    if (template) {
      await this.processes.run(process.execPath, [bridge, "replace", pi.root, workspace,
        JSON.stringify({ old: template, target })], this.cwd);
    }
    return installed.version;
  }

  async start(pi: PiInstallation, workspace: string): Promise<void> {
    await access(guard, constants.R_OK);
    await this.processes.run(pi.command, ["--extension", guard, "/pbot init"], resolve(workspace), { interactive: true, timeoutMs: 0 });
  }
}
