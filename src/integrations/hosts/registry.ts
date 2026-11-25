import { requireThat } from "../../common/validation.js";
import type { PluginHostAdapter, PluginHostId } from "../../model/plugin-host.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";

/** Extensible registry of hook-based plugin host adapters; runtime never branches on host IDs. */
export class PluginHostRegistry {
  readonly #adapters = new Map<PluginHostId, PluginHostAdapter>();

  constructor(initial: readonly PluginHostAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: PluginHostAdapter): this {
    requireThat(typeof adapter.host === "string" && adapter.host.length > 0, "插件宿主标识无效。");
    this.#adapters.set(adapter.host, adapter);
    return this;
  }

  unregister(host: PluginHostId): boolean {
    return this.#adapters.delete(host);
  }

  get(host: PluginHostId): PluginHostAdapter | undefined {
    return this.#adapters.get(host);
  }

  require(host: PluginHostId): PluginHostAdapter {
    const adapter = this.#adapters.get(host);
    requireThat(adapter, `未注册的插件宿主：${host}。可用宿主：${this.list().join(", ")}`);
    return adapter;
  }

  list(): PluginHostId[] {
    return [...this.#adapters.keys()];
  }
}

export const pluginHosts = new PluginHostRegistry([claudeAdapter, antigravityAdapter]);
export const registerPluginHost = (adapter: PluginHostAdapter) => pluginHosts.register(adapter);
export const getPluginHost = (host: PluginHostId) => pluginHosts.get(host);
export const listPluginHosts = () => pluginHosts.list();
