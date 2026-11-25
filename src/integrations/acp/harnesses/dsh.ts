import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpHarnessAdapter } from "../../../model/acp.js";
import { defaultPrepareLaunch, filterStandardAcpOptions, validateStandardAcpOptions } from "./generic.js";

export const dshAcpHarness: AcpHarnessAdapter = {
  id: "dsh",
  label: "DeepSeek dsh",
  defaultCommand: { command: "dsh", args: ["--profile", "acp"] },
  installHint: "npm install -g @deepseek-ai/dsh@latest",
  configureHint: "按 dsh 原生方式配置目标 profile 的模型与认证。",
  exactAnswer: true,
  eagerSessionId: true,
  filterStartOptions: filterStandardAcpOptions,
  validateStartOptions: options => validateStandardAcpOptions("dsh", options),
  async prepareLaunch(context) {
    const base = defaultPrepareLaunch(context);
    const patch = join(context.directory, "acp-dsh-patch.json");
    await writeFile(
      patch,
      JSON.stringify([{ insert: [{ id: "pbot-acp-member", name: join(context.packageRoot, "lib/extension/dsh/acp-member.js") }] }]) + "\n",
      { mode: 0o600 },
    );
    return {
      ...base,
      command: { ...base.command, args: [...base.command.args, "--patch", patch] },
    };
  },
  parseModelValue(value) {
    try {
      const parts: unknown = JSON.parse(value);
      if (Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === "string" && part.length > 0)) {
        return { provider: parts[0], model: parts[1] };
      }
    } catch { /* Unencoded identifiers remain usable as exact ACP option values. */ }
    return { model: value };
  },
};
