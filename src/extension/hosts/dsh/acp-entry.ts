import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Keep normal dsh profile resolution. A standalone plugin cache has no SDK
// peers of its own, so resolve missing peers from the running dsh installation.
const memberLib = new URL("../../../", import.meta.url).href;
const peers = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@deepseek-ai/") && context.parentURL?.startsWith(memberLib)) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND" || !process.argv[1]) throw error;
        return nextResolve(specifier, { ...context, parentURL: pathToFileURL(realpathSync(process.argv[1])).href });
      }
    }
    return nextResolve(specifier, context);
  },
});

export const { name, inject, apply } = await import("./acp-member.js").finally(() => peers.deregister());
