import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

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
      const cancel = () => stop(new Error("操作已取消。"));
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
