import { realpath } from "node:fs/promises";
import { activatePython } from "../integrations/python-activation.js";
import { requireThat } from "../common/validation.js";
import { authorizeMutation } from "../services/workspace/workspace-files.js";
import type { AgentOwner } from "../model/agent.js";
import type { PythonEnvironmentService } from "../services/workspace/python-environment-service.js";
import type { AgentService } from "../services/agents/agent-service.js";
import type { CallAccess } from "../tools/access.js";

export class WorkspaceInstance implements CallAccess {
  readonly #controller = new AbortController();
  #work = new AbortController();
  #closing: Promise<void> | undefined;
  #restorePython: (() => void) | undefined;
  constructor(readonly root: string, readonly pythonEnvironment: PythonEnvironmentService, readonly agents: AgentService) {}
  async preparePython(signal?: AbortSignal) {
    this.check();
    this.#restorePython?.();
    this.#restorePython = undefined;
    const result = await this.pythonEnvironment.setup(signal);
    this.check();
    this.#restorePython ??= activatePython(result.directory);
    return result;
  }
  check() {
    requireThat(!this.#controller.signal.aborted, "pbot 工作区实例已关闭。");
  }
  signal(signal?: AbortSignal) {
    this.check();
    return AbortSignal.any([this.#controller.signal, this.#work.signal, ...(signal ? [signal] : [])]);
  }
  async authorizeFile(path: string, change: unknown, confirm: (value: unknown) => Promise<boolean>, signal: AbortSignal) {
    this.check();
    await authorizeMutation(this.root, path, change, confirm, signal);
    this.check();
  }
  agentOwner: AgentOwner | undefined;
  cancelWork() {
    this.#work.abort();
    this.#work = new AbortController();
  }
  close(preserveAgents = false): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#controller.abort();
    this.#work.abort();
    this.#closing = (async () => {
      try {
        const results = await Promise.allSettled([this.agents.close(this.agentOwner, preserveAgents), this.pythonEnvironment.close()]);
        const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "工作区关闭失败。");
      } finally { this.#restorePython?.(); this.#restorePython = undefined; }
    })();
    return this.#closing;
  }
}
export class Lifecycle {
  #active: WorkspaceInstance | undefined;
  constructor(private readonly create: (root: string) => WorkspaceInstance,
    private readonly register: (instance: WorkspaceInstance) => void, private readonly hide: () => void) {}
  get active() { return this.#active; }
  get() {
    requireThat(this.#active, "pbot 工作区实例不可用。");
    this.#active.check(); return this.#active;
  }
  async open(root: string) {
    await this.close();
    const instance = this.create(await realpath(root));
    this.#active = instance;
    try { this.register(instance); }
    catch (error) { await this.close(); throw error; }
  }
  async close(preserveAgents = false) {
    const old = this.#active;
    this.#active = undefined;
    try { await old?.close(preserveAgents); } finally { this.hide(); }
  }
}
