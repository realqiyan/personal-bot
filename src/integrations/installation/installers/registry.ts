import { requireThat } from "../../../common/validation.js";
import type { HostInstaller } from "../../../model/installation.js";
import { antigravityInstaller } from "./antigravity.js";
import { claudeInstaller } from "./claude.js";
import { codexInstaller } from "./codex.js";
import { dshInstaller } from "./dsh.js";
import { piInstaller } from "./pi.js";
import { qoderInstaller } from "./qoder.js";

/** Extensible registry of per-host plugin installers; core install orchestration never branches on host IDs. */
export class HostInstallerRegistry {
  readonly #installers = new Map<string, HostInstaller>();

  constructor(initial: readonly HostInstaller[] = []) {
    for (const installer of initial) this.register(installer);
  }

  register(installer: HostInstaller): this {
    requireThat(typeof installer.host === "string" && installer.host.length > 0, "宿主安装适配器标识无效。");
    this.#installers.set(installer.host, installer);
    return this;
  }

  unregister(host: string): boolean {
    return this.#installers.delete(host);
  }

  get(host: string): HostInstaller | undefined {
    return this.#installers.get(host);
  }

  list(): string[] {
    return [...this.#installers.keys()];
  }
}

export const hostInstallers = new HostInstallerRegistry([
  piInstaller,
  dshInstaller,
  claudeInstaller,
  antigravityInstaller,
  codexInstaller,
  qoderInstaller,
]);

export const registerHostInstaller = (installer: HostInstaller) => hostInstallers.register(installer);
export const getHostInstaller = (host: string) => hostInstallers.get(host);
export const listHostInstallers = () => hostInstallers.list();
