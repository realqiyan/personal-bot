import { fork, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentHost } from "../../services/agents/agent-service.js";
import type { AgentDescriptor, AgentOptions, AgentSessionReference } from "../../model/agent.js";
import type { AcpBackend, AcpCommands } from "../../model/acp.js";
import { AgentFiles, launch } from "../../storage/agent-files.js";
import { acpInput, acpProcess, acpReference, acpReport } from "../../storage/acp-files.js";
import { fileId } from "../../storage/file-access.js";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";
import { acpLaunch } from "./launch.js";

/** Select the native strategy or one of the three explicit ACP targets per member. */
export class AgentBackends implements AgentHost {
  readonly kind;
  readonly files: AgentFiles;
  readonly worker = resolve(resourceRoot, "../lib/extension/acp-worker.js");
  constructor(readonly native: AgentHost, directory: string, readonly commands: AcpCommands = {}) {
    this.kind = native.kind; this.files = new AgentFiles(directory, native.kind);
  }
  available(backend?: AcpBackend) {
    if (!backend) return this.native.available();
    requireThat(process.platform === "linux" || process.platform === "darwin", "ACP worker 当前支持 Linux 和 macOS。");
    requireThat(existsSync(this.worker), "缺少 ACP worker 构建产物；请先运行 npm run build。");
  }
  prepare(backend: AcpBackend, options: AgentOptions) { return acpLaunch(backend, this.commands, options); }
  validateOptions(options: AgentOptions, backend?: AcpBackend) {
    if (backend) this.prepare(backend, options); else this.native.validateOptions?.(options);
  }
  private isAcp(id: string) { return Boolean(this.files.optional(id, "acp-session.json", acpReference)); }
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
  alive(id: string) { return this.isAcp(id) ? Boolean(this.process(id)) : this.native.alive(id); }
  async validateSession(d: AgentDescriptor, reference: AgentSessionReference) {
    if (reference.host !== "acp") return this.native.validateSession(d, reference);
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
    const child = fork(this.worker, ["--pbot-acp-agent", d.agentId, "--generation", generation, "--directory", this.files.directory(d.agentId),
      "--host", this.kind, ...(validate ? ["--validate"] : [])], {
      cwd: d.cwd, env: { ...process.env }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    });
    return child;
  }
  async launch(d: AgentDescriptor, directory: string, generation: string, reference: AgentSessionReference, resume: boolean, signal: AbortSignal) {
    if (reference.host !== "acp") return this.native.launch(d, directory, generation, reference, resume, signal);
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
    if (!this.isAcp(id)) return this.native.release(id, generation);
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
  report(d: AgentDescriptor, reference: AgentSessionReference, leaf: string) {
    if (reference.host !== "acp") return this.native.report(d, reference, leaf);
    requireThat(leaf.startsWith("acp:"), "ACP 报告引用无效。");
    const cycleId = fileId(leaf.slice(4)), report = this.files.read(d.agentId, join("reports", cycleId + ".json"), acpReport);
    requireThat(report.cycleId === cycleId, "ACP 报告周期不匹配。");
    return report.text;
  }
}
