import { object } from "../../../common/json.js";
import { requireThat } from "../../../common/validation.js";
import type { AcpHarnessAdapter } from "../../../model/acp.js";
import { claudeOptions } from "../claude.js";
import { defaultPrepareLaunch, filterStandardAcpOptions, validateStandardAcpOptions } from "./generic.js";

export const claudeAcpHarness: AcpHarnessAdapter = {
  id: "claude",
  defaultCommand: { command: "claude-agent-acp", args: [] },
  installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
  configureHint: "在 Claude Code 中完成登录或 API 配置，并设置默认模型。",
  requireSystemPrompt: true,
  customNotificationMethod: "_claude/sdkMessage",
  filterStartOptions(options) {
    const filtered = filterStandardAcpOptions(options);
    delete filtered.provider;
    return filtered;
  },
  validateStartOptions(options) {
    validateStandardAcpOptions("claude", options);
    requireThat(options.noSkills === undefined && options.tools === undefined, "Claude 子代理的技能和工具通过 Claude 原生配置选择。");
    requireThat(options.provider === undefined, "Claude 子代理使用原生提供方配置；请仅指定目标 model。");
  },
  async prepareLaunch(context) {
    const base = defaultPrepareLaunch(context);
    const claude = await claudeOptions(base.command, context.cwd, context.options.thinking);
    return {
      ...base,
      ...(claude.thinking ? { defaultThinking: claude.thinking } : {}),
      sessionMeta: {
        claudeCode: {
          options: { ...claude.options, disallowedTools: ["Agent", "Task"] },
          emitRawSDKMessages: [{ type: "system", subtype: "init" }],
        },
      },
    };
  },
  parseModelValue: value => ({ model: value }),
  parseCustomNotification(params, sessionId) {
    if (!object(params) || params.sessionId !== sessionId) return undefined;
    const message = params.message;
    if (!object(message) || message.type !== "system" || message.subtype !== "init" || typeof message.model !== "string" || !message.model) {
      return undefined;
    }
    return { resolvedModel: message.model };
  },
};
