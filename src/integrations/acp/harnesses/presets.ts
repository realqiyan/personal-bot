import type { AcpHarnessAdapter } from "../../../model/acp.js";
import { createGenericAcpHarness } from "./generic.js";

/** Declarative standard ACP v1 presets requiring no host-specific adapter code. */
export const standardAcpPresets: readonly AcpHarnessAdapter[] = [
  createGenericAcpHarness("antigravity", {
    defaultCommand: { command: "agy", args: ["acp"] },
    installHint: "安装 Google Antigravity CLI（agy）",
    configureHint: "运行 agy 完成登录与默认模型配置。",
  }),
  createGenericAcpHarness("codex", {
    defaultCommand: { command: "codex-acp", args: [] },
    installHint: "npm install -g @zed-industries/codex-acp",
    configureHint: "在 Codex 中完成登录或 API 配置。",
  }),
];
