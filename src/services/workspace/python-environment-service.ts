import { join } from "node:path";
import { object } from "../../common/json.js";
import { runCommand } from "../../integrations/process.js";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";

export class PythonEnvironmentService {
  readonly #shutdown = new AbortController();
  #pending: Promise<{ directory: string; python: string }> | undefined;
  #status: { state: "unprepared" | "preparing" | "ready" | "error"; directory?: string; error?: string } = { state: "unprepared" };
  constructor(private readonly root: string) {}
  get status() { return { ...this.#status }; }

  private async run(checkOnly: boolean, signal: AbortSignal) {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
    const result = await runCommand("/bin/sh", ["-c", 'exec "$(command -v python3 || command -v python)" "$@"',
      "pbot-python", "-I", "-B", join(resourceRoot, "../scripts/setup-python.py"), ...(checkOnly ? ["--check"] : [])],
    undefined, this.root, environment, signal, { timeoutMs: 15 * 60_000 });
    signal.throwIfAborted();
    requireThat(result.success && object(result.data) && typeof result.data.directory === "string" && typeof result.data.python === "string",
      "共享 Python 环境未就绪；修复后执行 Python 准备入口。\n" + JSON.stringify(result.data).slice(-6000));
    return { directory: result.data.directory, python: result.data.python, action: result.data.action };
  }

  async inspect(signal?: AbortSignal) {
    const cancel = signal ? AbortSignal.any([this.#shutdown.signal, signal]) : this.#shutdown.signal;
    try {
      const result = await this.run(true, cancel);
      this.#status = result.action === "verify" ? { state: "ready", directory: result.directory } : { state: "unprepared" };
      return this.status;
    } catch (error) {
      this.#status = { state: "error", error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  setup(signal?: AbortSignal): Promise<{ directory: string; python: string }> {
    const cancel = signal ? AbortSignal.any([this.#shutdown.signal, signal]) : this.#shutdown.signal;
    if (cancel.aborted) return Promise.reject(cancel.reason);
    if (this.#pending) return this.#pending;
    this.#status = { state: "preparing" };
    this.#pending = (async () => {
      try {
        const result = await this.run(false, cancel);
        const ready = { directory: result.directory, python: result.python };
        this.#status = { state: "ready", directory: ready.directory };
        return ready;
      } catch (error) {
        this.#status = { state: "error", error: error instanceof Error ? error.message : String(error) };
        throw error;
      } finally { this.#pending = undefined; }
    })();
    return this.#pending;
  }

  async close(): Promise<void> {
    this.#shutdown.abort();
    await this.#pending?.catch(() => undefined);
  }
}
