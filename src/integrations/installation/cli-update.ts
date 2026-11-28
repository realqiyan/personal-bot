import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gt, lt, valid } from "semver";
import { object } from "../../common/json.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { packageVersion } from "../../common/version.js";

/** Check exact installed manifests, never resolve dependencies in an ancestor workspace. */
export async function minimumCliRelease(root: string, plugins: Record<string, string>): Promise<string | undefined> {
  const versions = Object.values(plugins);
  if (process.env.PBOT_PLUGIN_VERSION) versions.push(process.env.PBOT_PLUGIN_VERSION);
  for (const prefix of ["", ".pi/npm"]) {
    const path = join(root, prefix, "node_modules/personal-bot/package.json");
    try {
      const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
      requireThat(object(manifest) && manifest.name === "personal-bot" && typeof manifest.version === "string",
        "无效的 personal-bot 安装清单：" + path);
      versions.push(manifest.version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let required: string | undefined;
  for (const version of versions) {
    requireThat(valid(version) && /^[0-9]/.test(version) && version === version.trim(), "无效的插件发布版本：" + version);
    if (!required || gt(version, required)) required = version;
  }
  return required;
}

async function runProgram(command: string, args: string[], env: NodeJS.ProcessEnv, install = false, input?: string): Promise<number> {
  const child = spawn(command, args, install
    ? { cwd: homedir(), stdio: ["ignore", 2, 2], env }
    : { stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], env });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveCode(code ?? (signal === "SIGINT" ? 130 : 143)));
      if (input !== undefined && child.stdin) {
        child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
        child.stdin.end(input);
      }
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function globalPackage(): Promise<string | undefined> {
  const { stdout } = await promisify(execFile)("npm", ["root", "--global"], { cwd: homedir() });
  const directory = join(stdout.trim(), "personal-bot");
  try {
    // An npm link points at a development checkout; keep updates out of that checkout.
    if ((await lstat(directory)).isDirectory() && await realpath(directory) === await realpath(resolve(resourceRoot, ".."))) return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

async function upgradeGlobal(directory: string, required: string, env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const lib = dirname(dirname(directory));
  const lock = join(lib, ".pbot-cli-update.lock");
  try { await mkdir(lock); }
  catch (error) {
    // A read-only prefix or an active updater can still use npm's per-user versioned cache.
    if (["EEXIST", "EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  const installedVersion = async () => {
    const installed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    requireThat(object(installed) && installed.name === "personal-bot" && typeof installed.version === "string" && valid(installed.version),
      "全局 CLI 安装清单无效：" + directory);
    return installed.version;
  };
  try {
    if (lt(await installedVersion(), required)) {
      const code = await runProgram("npm", ["install", "--global", "--prefix", dirname(lib), "--ignore-scripts",
        "--no-audit", "--no-fund", "--prefer-offline", "personal-bot@" + required], env, true);
      if (code) return code;
      requireThat(!lt(await installedVersion(), required), "npm 更新后的 CLI 低于插件所需版本：" + required);
    }
    return 0;
  } finally {
    await rmdir(lock);
  }
}

export async function upgradeManagedGlobalCli(required: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  state: "updated" | "up-to-date" | "skipped" | "failed";
  globalDirectory?: string;
  exitCode?: number;
  detail: string;
}> {
  requireThat(valid(required) && /^[0-9]/.test(required) && required === required.trim(), "无效的插件发布版本：" + required);
  if (!lt(packageVersion, required)) {
    return { state: "up-to-date", detail: `CLI 已是 ${packageVersion}。` };
  }
  const global = await globalPackage();
  if (!global) {
    return { state: "skipped", detail: `当前运行的是本地或非全局安装（${packageVersion}），跳过全局 CLI 覆盖。` };
  }
  const status = await upgradeGlobal(global, required, env);
  if (status === undefined) {
    return { state: "skipped", globalDirectory: global, detail: "全局 npm 目录不可写或正被其他进程更新，已跳过全局 CLI 覆盖。" };
  }
  if (status !== 0) {
    return { state: "failed", globalDirectory: global, exitCode: status, detail: `npm 更新全局 personal-bot@${required} 失败（退出码 ${status}）。` };
  }
  return { state: "updated", globalDirectory: global, detail: `已将全局 CLI 从 ${packageVersion} 更新到 ${required}。` };
}

export function execCliEntry(entry: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return runProgram(process.execPath, [entry, ...args], env, false);
}

/** Upgrade managed global installs in place. Project, npx and linked installs use npm's shared version cache. */
export async function runUpdatedCli(required: string | undefined, args: readonly string[], input?: string): Promise<number | undefined> {
  if (!required) return undefined;
  requireThat(valid(required) && /^[0-9]/.test(required) && required === required.trim(), "无效的插件发布版本：" + required);
  if (!lt(packageVersion, required)) return undefined;
  requireThat(process.env.PBOT_CLI_UPDATING !== required,
    `npm 启动了 CLI ${packageVersion}，工作区插件需要 ${required}。`);
  console.error(`工作区需要 Personal Bot CLI ${required}，正在更新 ${packageVersion}。`);
  const env = { ...process.env, PBOT_CLI_UPDATING: required };
  const global = await globalPackage();
  if (global) {
    const status = await upgradeGlobal(global, required, env);
    if (status !== undefined) {
      if (status !== 0) return status;
      return runProgram(process.execPath, [join(global, "bin/pbot.mjs"), ...args], env, false, input);
    }
  }
  return runProgram("npx", ["--yes", "--ignore-scripts", "--prefer-offline", "personal-bot@" + required, ...args], env, false, input);
}
