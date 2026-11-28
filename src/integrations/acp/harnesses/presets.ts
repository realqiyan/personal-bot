import type { AcpHarnessAdapter } from "../../../model/acp.js";
import { createGenericAcpHarness } from "./generic.js";

/** Declarative standard ACP v1 presets requiring no host-specific adapter code. */
export const standardAcpPresets: readonly AcpHarnessAdapter[] = [
  createGenericAcpHarness("antigravity", {
    label: "Google Antigravity",
    aliases: ["agy"],
    defaultCommand: { command: "agy", args: ["acp"] },
    installHint: "安装 Google Antigravity CLI（agy）",
    configureHint: "运行 agy 完成登录与默认模型配置。",
    nativeWorkspaceSkills: true,
  }),
  createGenericAcpHarness("qoder", {
    label: "Qoder CLI",
    aliases: ["qodercli", "qoder-cli"],
    nativeWorkspaceSkills: true,
    defaultCommand: { command: "qodercli", args: ["--acp"] },
    installHint: "安装 Qoder CLI（qodercli）",
    configureHint: "运行 qodercli login 完成登录。",
  }),
  createGenericAcpHarness("codex", {
    label: "OpenAI Codex",
    aliases: ["openai-codex", "codex-cli"],
    defaultCommand: { command: "codex-acp", args: [] },
    installHint: "npm install -g @agentclientprotocol/codex-acp",
    configureHint: "在 Codex 中完成登录或 API 配置。",
    nativeWorkspaceSkills: true,
  }),
];
