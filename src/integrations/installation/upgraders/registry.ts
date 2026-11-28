import { requireThat } from "../../../common/validation.js";
import type { HostUpgrader } from "../../../model/installation.js";
import { antigravityUpgrader } from "./antigravity.js";
import { claudeUpgrader } from "./claude.js";
import { codexUpgrader } from "./codex.js";
import { dshUpgrader } from "./dsh.js";
import { piUpgrader } from "./pi.js";
import { qoderUpgrader } from "./qoder.js";

/** Extensible registry of per-host plugin upgraders; core upgrade orchestration never branches on host IDs. */
export class HostUpgraderRegistry {
  readonly #upgraders = new Map<string, HostUpgrader>();

  constructor(initial: readonly HostUpgrader[] = []) {
    for (const upgrader of initial) this.register(upgrader);
  }

  register(upgrader: HostUpgrader): this {
    requireThat(typeof upgrader.host === "string" && upgrader.host.length > 0, "宿主升级适配器标识无效。");
    this.#upgraders.set(upgrader.host, upgrader);
    return this;
  }

  unregister(host: string): boolean {
    return this.#upgraders.delete(host);
  }

  get(host: string): HostUpgrader | undefined {
    return this.#upgraders.get(host);
  }

  list(): string[] {
    return [...this.#upgraders.keys()];
  }
}

export const hostUpgraders = new HostUpgraderRegistry([
  piUpgrader,
  claudeUpgrader,
  antigravityUpgrader,
  codexUpgrader,
  qoderUpgrader,
  dshUpgrader,
]);

export const registerHostUpgrader = (upgrader: HostUpgrader) => hostUpgraders.register(upgrader);
export const getHostUpgrader = (host: string) => hostUpgraders.get(host);
export const listHostUpgraders = () => hostUpgraders.list();
