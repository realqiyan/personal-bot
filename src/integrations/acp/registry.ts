import { isAcpBackend, requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpHarnessAdapter } from "../../model/acp.js";
import { claudeAcpHarness } from "./harnesses/claude.js";
import { dshAcpHarness } from "./harnesses/dsh.js";
import { createGenericAcpHarness } from "./harnesses/generic.js";
import { piAcpHarness } from "./harnesses/pi.js";
import { standardAcpPresets } from "./harnesses/presets.js";

/** Extensible registry of ACP harness adapters; arbitrary custom harnesses resolve to generic ACP v1. */
export class AcpHarnessRegistry {
  readonly #adapters = new Map<AcpBackend, AcpHarnessAdapter>();

  constructor(initial: readonly AcpHarnessAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: AcpHarnessAdapter): this {
    requireThat(isAcpBackend(adapter.id), "ACP harness 标识无效：" + String(adapter.id));
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  unregister(id: AcpBackend): boolean {
    return this.#adapters.delete(id);
  }

  get(id: AcpBackend): AcpHarnessAdapter | undefined {
    return this.#adapters.get(id);
  }

  resolve(id: AcpBackend): AcpHarnessAdapter {
    requireThat(isAcpBackend(id), "无效的 ACP harness 标识：" + String(id));
    return this.#adapters.get(id) ?? createGenericAcpHarness(id);
  }

  list(): AcpBackend[] {
    return [...this.#adapters.keys()];
  }
}

export const acpHarnesses = new AcpHarnessRegistry([
  piAcpHarness,
  dshAcpHarness,
  claudeAcpHarness,
  ...standardAcpPresets,
]);

export const registerAcpHarness = (adapter: AcpHarnessAdapter) => acpHarnesses.register(adapter);
export const getAcpHarness = (id: AcpBackend) => acpHarnesses.get(id);
export const resolveAcpHarness = (id: AcpBackend) => acpHarnesses.resolve(id);
export const listAcpHarnesses = () => acpHarnesses.list();
