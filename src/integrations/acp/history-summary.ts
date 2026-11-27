import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommands } from "../../model/acp.js";
import type { HistorySummarizer } from "../../model/history.js";
import { acpLaunch, canonicalAcpBackend } from "./launch.js";

export interface AcpHistorySummarizerOptions {
  cwd: string;
  backend?: AcpBackend;
  commands?: AcpCommands;
  model?: string;
  thinking?: string;
  timeoutMs?: number;
}

const defaultTimeoutMs = 180_000;

/**
 * Spawns one isolated, ephemeral ACP worker process per summary task (default backend: "pi").
 * Each worker runs with PBOT_SUBAGENT_RUN_ID set (so no host records raw history),
 * denies all write/tool permissions, uses the target harness's default model unless overridden,
 * and exits immediately after returning the summary text.
 */
export function createAcpHistorySummarizer(options: AcpHistorySummarizerOptions): HistorySummarizer {
  const workerPath = resolve(resourceRoot, "../lib/extension/acp-worker.js");
  requireThat(process.platform === "linux" || process.platform === "darwin", "ACP 摘要 worker 当前支持 Linux 和 macOS。");
  requireThat(existsSync(workerPath), "缺少 ACP worker 构建产物；请先运行 npm run build。");

  const commands = options.commands ?? {};
  const backend = canonicalAcpBackend(options.backend ?? "pi", commands);
  const reference = acpLaunch(backend, commands, {});
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  return async (request, signal) => {
    signal.throwIfAborted();
    return await new Promise<string>((resolveAnswer, reject) => {
      const child = fork(workerPath, ["--prompt"], {
        cwd: options.cwd,
        env: { ...process.env },
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
      });

      let answer: string | undefined;
      let failure: Error | undefined;
      let settled = false;

      const killGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { /* Process group already exited. */ }
      };

      const onAbort = () => {
        const abortError = signal.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("历史摘要已取消。"), { name: "AbortError" });
        failure = abortError;
        killGroup();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        failure = new Error(`ACP 摘要 worker（${backend}）执行超时。`);
        killGroup();
      }, timeoutMs);

      const finish = (err?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolveAnswer(value!);
      };

      child.on("message", (message: { type?: string; text?: string; error?: string }) => {
        if (message.type === "answer" && typeof message.text === "string") answer = message.text;
        if (message.type === "error") failure = new Error(message.error ?? `ACP 摘要 worker（${backend}）失败。`);
      });
      child.once("error", error => { failure = error; });
      child.once("spawn", () => {
        if (signal.aborted) { onAbort(); return; }
        child.send({
          reference,
          cwd: options.cwd,
          system: request.system,
          prompt: request.prompt,
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinking ? { thinking: options.thinking } : {}),
        });
      });
      child.once("close", code => {
        if (signal.aborted) {
          finish(failure ?? Object.assign(new Error("历史摘要已取消。"), { name: "AbortError" }));
        } else if (answer && code === 0 && !failure) {
          finish(undefined, answer);
        } else {
          finish(failure ?? new Error(`ACP 摘要 worker（${backend}）异常退出（code=${String(code)}）。`));
        }
      });
    });
  };
}
