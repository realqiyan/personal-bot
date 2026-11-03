import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { SystemCommand } from "../../services/installation/setup-service.js";

export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const path = resolve(directory, name);
    // npm exec prepends transient bins. Never use a cached peer as the user's Pi.
    if (name === "pi" && path.split(/[\\/]/).includes("_npx")) continue;
    try {
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) continue;
      const target = await realpath(path);
      if (name === "pi" && target.split(/[\\/]/).includes("_npx")) continue;
      return path;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return undefined;
}

export class SetupProcesses {
  constructor(readonly signal: AbortSignal, readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(command: string, args: string[], cwd: string,
    options: { interactive?: boolean; timeoutMs?: number; input?: string } = {}): Promise<string> {
    this.signal.throwIfAborted();
    if (!isAbsolute(cwd)) throw new Error("进程工作目录必须是绝对路径。");
    const interactive = options.interactive ?? false;
    const timeoutMs = options.timeoutMs ?? (interactive ? 15 * 60_000 : 60_000);
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, args, { cwd, env: this.env, shell: false, detached: !interactive,
        stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failure: Error | undefined, escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { if (interactive) child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Process already exited. */ }
      };
      const stop = (reason: Error) => {
        if (failure) return;
        failure = reason;
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 2000);
      };
      const cancel = () => stop(new Error("安装已取消。"));
      const timer = timeoutMs > 0 ? setTimeout(() => stop(new Error(`命令超时：${command}`)), timeoutMs) : undefined;
      this.signal.addEventListener("abort", cancel, { once: true });
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) stop(new Error(`命令输出超过限制：${command}`));
        else chunks.push(chunk);
      };
      child.stdout?.on("data", collect(stdout)); child.stderr?.on("data", collect(stderr));
      child.stdin?.on("error", () => { /* An exiting child may close stdin early. */ });
      child.on("error", error => { failure = error; });
      child.on("close", (code, exitSignal) => {
        clearTimeout(timer); clearTimeout(escalation);
        this.signal.removeEventListener("abort", cancel);
        if (this.signal.aborted) return reject(this.signal.reason);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(`${command} 失败 (${exitSignal ?? code})\n${Buffer.concat(stderr).toString("utf8").slice(-8000)}`));
        resolveResult(Buffer.concat(stdout).toString("utf8").trim());
      });
      child.stdin?.end(options.input);
      if (this.signal.aborted) cancel();
    });
  }
}

export function tmuxInstallCommand(platform: string, commands: ReadonlyMap<string, string>, root: boolean): SystemCommand {
  let command: string | undefined, args: string[];
  if (platform === "darwin") {
    command = commands.get("brew"); args = ["install", "tmux"];
  } else {
    const manager = ["apt-get", "dnf", "pacman", "zypper", "apk"].find(name => commands.has(name));
    command = manager ? commands.get(manager) : undefined;
    args = manager === "apt-get" ? ["install", "-y", "tmux"] : manager === "dnf" ? ["install", "-y", "tmux"]
      : manager === "pacman" ? ["-S", "--needed", "--noconfirm", "tmux"]
      : manager === "zypper" ? ["--non-interactive", "install", "tmux"] : ["add", "tmux"];
    if (command && !root) {
      const sudo = commands.get("sudo");
      if (!sudo) throw new Error("安装 tmux 需要管理员权限；请手动安装 tmux 后重新运行 setup。");
      return { command: sudo, args: [command, ...args] };
    }
  }
  if (!command) throw new Error(platform === "darwin"
    ? "未找到 Homebrew。请先通过现有环境安装 tmux，再运行 setup。"
    : "未找到支持的系统包管理器。请手动安装 tmux，再运行 setup。");
  return { command, args };
}

export async function inspectSystem(processes: SetupProcesses, cwd: string): Promise<{ npm: string; tmux?: SystemCommand }> {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("setup 支持 Linux 和 macOS；Windows 请使用 WSL。");
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error("需要 Node.js 22.19 或更高版本。");
  const npm = await findExecutable("npm", processes.env);
  if (!npm) throw new Error("未找到 npm。请先安装 Node.js/npm。");
  const python = await findExecutable("python3", processes.env) ?? await findExecutable("python", processes.env);
  if (!python) throw new Error("需要 Python 3.11+ 和 venv/ensurepip。请先安装后重试。");
  try {
    await processes.run(python, ["-I", "-B", "-c", [
      "import sys, tempfile, venv, ensurepip",
      "assert sys.version_info >= (3, 11), 'Python 3.11+ required'",
      "with tempfile.TemporaryDirectory(prefix='pbot-python-check-') as path:",
      "    venv.EnvBuilder(with_pip=True).create(path)",
    ].join("\n")], cwd);
  } catch (error) {
    processes.signal.throwIfAborted();
    throw new Error("基础 Python 检查失败。需要 Python 3.11+ 和 venv/ensurepip；Debian/Ubuntu 还需 python3-venv。\n" + String(error));
  }
  const tmux = await findExecutable("tmux", processes.env);
  if (tmux) { await processes.run(tmux, ["-V"], cwd); return { npm }; }
  const names = process.platform === "darwin" ? ["brew"] : ["apt-get", "dnf", "pacman", "zypper", "apk", "sudo"];
  const entries = await Promise.all(names.map(async name => [name, await findExecutable(name, processes.env)] as const));
  const commands = new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  return { npm, tmux: tmuxInstallCommand(process.platform, commands, process.getuid?.() === 0) };
}

export function npmGlobalBinary(prefix: string): string { return join(prefix, "bin", "pi"); }
