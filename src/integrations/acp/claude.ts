import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import type { AcpCommand } from "../../model/acp.js";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";

const levels = ["low", "medium", "high", "xhigh", "max"];
export interface ClaudeConfiguration {
  thinking?: string;
  options: { plugins: { type: "local"; path: string }[]; effort?: string; settings?: { env: { CLAUDE_CODE_EFFORT_LEVEL: string } } };
}

/** Read the target installation's native settings without creating a model session. */
export async function claudeOptions(command: AcpCommand, cwd: string, requested?: string): Promise<ClaudeConfiguration> {
  const script = command.args[0];
  const anchor = ["node", "node.exe"].includes(basename(command.command)) && script && !script.startsWith("-") ? resolve(cwd, script) : command.command;
  const require = createRequire(pathToFileURL(anchor));
  const sdk: unknown = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
  requireThat(object(sdk) && typeof sdk.resolveSettings === "function", "Claude ACP 需要提供 resolveSettings 的原生 SDK。");
  const resolved: unknown = await sdk.resolveSettings({ cwd });
  requireThat(object(resolved) && object(resolved.effective), "Claude 原生设置解析失败。");
  const environment = object(resolved.effective.env) ? resolved.effective.env : {};
  const configured = environment.CLAUDE_CODE_EFFORT_LEVEL ?? process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const explicit = requested !== undefined && requested !== "default";
  requireThat(!explicit || levels.includes(requested), "Claude 思考等级不可用：" + requested);
  const effort = explicit ? requested : typeof configured === "string" && levels.includes(configured) ? configured : undefined;
  const thinking = effort ?? (configured === "unset" ? "unset" : undefined);
  return {
    ...(thinking ? { thinking } : {}),
    options: {
      plugins: [{ type: "local", path: join(resourceRoot, "skills") }],
      ...(effort ? { effort } : {}),
      // SDK effort alone loses to CLAUDE_CODE_EFFORT_LEVEL. A flag-tier env entry
      // applies the explicit choice to this invocation and preserves other settings.
      ...(explicit ? { settings: { env: { CLAUDE_CODE_EFFORT_LEVEL: requested } } } : {}),
    },
  };
}
