import { fork, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentHost } from "../../services/agents/agent-service.js";
import type { AgentDescriptor, AgentOptions, AgentSessionReference } from "../../model/agent.js";
import type { AcpBackend, AcpCommands, AcpModelsResult } from "../../model/acp.js";
import { AgentFiles, launch } from "../../storage/agent-files.js";
import { acpInput, acpProcess, acpReport } from "../../storage/acp-files.js";
import { fileId } from "../../storage/file-access.js";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";
import { acpLaunch, filterAcpStartOptions } from "./launch.js";

/** Pure ACP v1 worker host; spawns isolated acp-worker child processes for any registered or custom harness. */
export class AcpWorkerHost implements AgentHost {
  readonly files: AgentFiles;
  readonly worker = resolve(resourceRoot, "../lib/extension/acp-worker.js");

  constructor(directory: string, readonly commands: AcpCommands = {}) {
    this.files = new AgentFiles(directory);
  }

  available(backend: AcpBackend) {
    requireThat(backend, "通过 worker_create 委派跨 Harness 专家时必须指定 backend（例如 pi、dsh、claude、antigravity、codex 或自定义 ACP 名称）。");
    requireThat(process.platform === "linux" || process.platform === "darwin", "ACP worker 当前支持 Linux 和 macOS。");
    requireThat(existsSync(this.worker), "缺少 ACP worker 构建产物；请先运行 npm run build。");
  }

  filterOptions(backend: AcpBackend, options: AgentOptions): AgentOptions {
    return filterAcpStartOptions(backend, options);
  }

  prepare(backend: AcpBackend, options: AgentOptions) {
    return acpLaunch(backend, this.commands, options);
  }

  /** Probe a backend's advertised model and thinking choices in an isolated ACP process without prompting. */
  async inspectModels(backend: AcpBackend, cwd: string, options: Pick<AgentOptions, "provider" | "model"> = {}): Promise<AcpModelsResult> {
    this.available(backend);
    const filtered = this.filterOptions(backend, options);
    const reference = this.prepare(backend, filtered);
    return await new Promise<AcpModelsResult>((resolveResult, reject) => {
      const child = fork(this.worker, ["--probe"], {
        cwd, env: { ...process.env }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
      });
      let result: AcpModelsResult | undefined, failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error("ACP 模型探测超时。");
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
        }
      }, 30_000);
      child.on("message", (message: { type?: string; result?: AcpModelsResult; error?: string }) => {
        if (message.type === "models" && message.result) result = message.result;
        if (message.type === "error") failure = new Error(message.error ?? "ACP 模型探测失败。");
      });
      child.once("error", error => { failure = error; });
      child.once("spawn", () => {
        child.send({
          reference,
          cwd,
          ...(filtered.provider ? { provider: filtered.provider } : {}),
          ...(filtered.model ? { model: filtered.model } : {}),
        });
      });
      child.once("close", code => {
        clearTimeout(timer);
        if (result && code === 0 && !failure) resolveResult(result);
        else reject(failure ?? new Error("ACP 模型探测失败。"));
      });
    });
  }

  private process(id: string) {
    const record = this.files.optional(id, "acp-process.json", acpProcess);
    if (!record || this.files.read(id, "launch.json", launch).generation !== record.generation) return;
    let denied = false;
    try { process.kill(-record.pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code !== "EPERM") throw error;
      denied = true;
    }
    const leader = spawnSync("ps", ["-p", String(record.pid), "-o", "args="], { encoding: "utf8" });
    // A dead leader can leave its group alive. A reused leader must match our exact launch identity.
    if (leader.status === 0 && !leader.stdout.includes("--pbot-acp-agent " + id + " --generation " + record.generation) || denied && leader.status !== 0) return;
    return record;
  }

  alive(id: string) {
    return Boolean(this.process(id));
  }

  async validateSession(d: AgentDescriptor, reference: AgentSessionReference) {
    requireThat(!this.alive(d.agentId), "ACP 成员仍在运行，不能恢复。");
    if (reference.sessionId === null) {
      requireThat(!this.files.optional(d.agentId, "acp-input.json", acpInput), "ACP 输入交付状态不明；请核对原请求后新建成员。");
      return;
    }
    const generation = this.files.read(d.agentId, "launch.json", launch).generation;
    await new Promise<void>((resolveResult, reject) => {
      const child = this.spawn(d, generation, true);
      let validated = false, failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error("ACP 恢复校验超时。");
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); } }
      }, 45_000);
      child.on("message", (message: { type?: string; error?: string }) => {
        if (message.type === "validated") validated = true;
        if (message.type === "error") failure = new Error(message.error ?? "ACP 恢复校验失败。");
      });
      child.once("error", error => { failure = error; });
      child.once("close", code => { clearTimeout(timer); if (validated && code === 0 && !failure) resolveResult(); else reject(failure ?? new Error("ACP 恢复校验失败；原代次和队列已保留。")); });
    });
  }

  private spawn(d: AgentDescriptor, generation: string, validate = false) {
    return fork(this.worker, ["--pbot-acp-agent", d.agentId, "--generation", generation, "--directory", this.files.directory(d.agentId),
      ...(validate ? ["--validate"] : [])], {
      cwd: d.cwd, env: { ...process.env }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    });
  }

  async launch(d: AgentDescriptor, _directory: string, generation: string, _reference: AgentSessionReference, _resume: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    const child = this.spawn(d, generation);
    await new Promise<void>((resolveResult, reject) => { child.once("spawn", resolveResult); child.once("error", reject); });
    requireThat(child.pid, "ACP worker 没有进程身份。");
    try { this.files.write(d.agentId, "acp-process.json", { generation, pid: child.pid, startedAt: Date.now() }, acpProcess); }
    catch (error) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw new AggregateError([error, failure], "ACP 启动与清理失败。"); }
      throw error;
    }
    if (child.connected) child.disconnect(); child.unref();
    if (signal.aborted) { await this.release(d.agentId, generation); signal.throwIfAborted(); }
  }

  async release(id: string, generation: string) {
    const record = this.process(id);
    if (!record || record.generation !== generation) return;
    const terminate = (signal: NodeJS.Signals) => {
      try { process.kill(-record.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    terminate("SIGTERM");
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const current = this.process(id);
      if (!current || current.generation !== generation || current.pid !== record.pid) return;
      await delay(100);
    }
    const current = this.process(id);
    if (current?.generation === generation && current.pid === record.pid) terminate("SIGKILL");
  }

  report(d: AgentDescriptor, _reference: AgentSessionReference, leaf: string) {
    requireThat(leaf.startsWith("acp:"), "ACP 报告引用无效。");
    const cycleId = fileId(leaf.slice(4)), report = this.files.read(d.agentId, join("reports", cycleId + ".json"), acpReport);
    requireThat(report.cycleId === cycleId, "ACP 报告周期不匹配。");
    return report.text;
  }
}
