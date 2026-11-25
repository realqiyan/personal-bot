import { join } from "node:path";
import type { AcpHarnessAdapter } from "../../../model/acp.js";
import { acpExecutable } from "../executable.js";
import { defaultPrepareLaunch } from "./generic.js";

export const piAcpHarness: AcpHarnessAdapter = {
  id: "pi",
  defaultCommand: { command: "pi-acp", args: [] },
  installHint: "npm install -g pi-acp",
  configureHint: "Pi 也需已安装；运行 pi 完成登录和默认模型配置。",
  exactAnswer: true,
  filterStartOptions: options => ({ ...options }),
  prepareLaunch(context) {
    const base = defaultPrepareLaunch(context);
    return {
      ...base,
      env: {
        ...base.env,
        PBOT_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND ?? acpExecutable("pi", "pi"),
        PI_ACP_PI_COMMAND: join(context.packageRoot, "bin/pbot-pi-acp.mjs"),
      },
    };
  },
  parseModelValue(value) {
    const separator = value.indexOf("/");
    if (separator > 0) return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
    return { model: value };
  },
  formatModelQuery(model, provider) {
    return provider ? provider + "/" + model : undefined;
  },
};
