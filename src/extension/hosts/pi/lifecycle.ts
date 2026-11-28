import { realpath } from "node:fs/promises";
import { requireThat } from "../../../common/validation.js";
import { authorizeMutation } from "../../../services/workspace/workspace-files.js";
import { readWorkspaceConfig, workspaceDisabledMessage, workspaceFeatures } from "../../../services/workspace/workspace-config.js";
import type { ResolvedWorkspaceFeatures, WorkspaceConfiguration } from "../../../model/workspace-config.js";
import type { McpWorkerRuntime } from "../../mcp/workers.js";

export class WorkspaceInstance {
  readonly #controller = new AbortController();
  #work = new AbortController();
  #closing: Promise<void> | undefined;

  constructor(
    readonly root: string,
    readonly sessionId: string,
    readonly workers: McpWorkerRuntime,
    readonly features: ResolvedWorkspaceFeatures = workspaceFeatures(),
  ) {}

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

  cancelWork() {
    this.#work.abort();
    this.#work = new AbortController();
  }

  close(preserveWorkers = false): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#controller.abort();
    this.#work.abort();
    this.#closing = (async () => {
      await this.workers.close(preserveWorkers);
    })();
    return this.#closing;
  }
}

export class Lifecycle {
  #active: WorkspaceInstance | undefined;
  configuration: WorkspaceConfiguration | undefined;
  root: string | undefined;

  constructor(
    private readonly create: (root: string, sessionId: string, configuration: WorkspaceConfiguration) => WorkspaceInstance,
    private readonly register: (instance: WorkspaceInstance) => void | Promise<void>,
    private readonly hide: () => void,
  ) {}

  get active() { return this.#active; }

  get() {
    requireThat(this.#active, this.configuration ? workspaceDisabledMessage(this.configuration) : "pbot 工作区实例不可用。");
    this.#active.check();
    return this.#active;
  }

  async open(root: string, sessionId: string) {
    await this.close();
    this.root = await realpath(root);
    this.configuration = await readWorkspaceConfig(this.root);
    if (!this.configuration.enabled) return;
    const instance = this.create(this.root, sessionId, this.configuration);
    this.#active = instance;
    try { await this.register(instance); }
    catch (error) { await this.close(); throw error; }
  }

  async close(preserveWorkers = false) {
    const old = this.#active;
    this.#active = undefined;
    try { await old?.close(preserveWorkers); } finally { this.hide(); }
  }
}
