import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommands, AcpSessionReference } from "../../model/acp.js";
import type { AgentOptions } from "../../model/agent.js";

export function acpExecutable(command: string): string {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  throw new Error("未找到 ACP 可执行文件：" + command + "。请安装并配置对应宿主，或在 .pbot/config.json 的 acp 中指定 command/args。");
}
export function acpLaunch(backend: AcpBackend, commands: AcpCommands, options: AgentOptions): AcpSessionReference {
  requireThat(["pi", "dsh", "claude"].includes(backend), "未知 ACP 后端。");
  requireThat(!options.provider || options.model, "ACP provider 需要同时指定目标 model。");
  if (backend !== "pi") for (const key of ["noExtensions", "noPromptTemplates", "noContextFiles"] as const) {
    requireThat(options[key] === undefined, backend + " ACP 不支持启动选项：" + key);
  }
  if (backend === "claude") {
    requireThat(options.noSkills === undefined && options.tools === undefined, "Claude ACP 的技能和工具通过 Claude 原生配置选择。");
    requireThat(options.provider === undefined, "Claude ACP 使用 Claude 原生提供方配置；请仅指定目标 model。");
  }
  const selected = commands[backend] ?? { command: backend === "pi" ? "pi-acp" : backend === "dsh" ? "dsh" : "claude-agent-acp", args: backend === "dsh" ? ["--profile", "acp"] : [] };
  return { host: "acp", backend, command: acpExecutable(selected.command), args: [...selected.args], sessionId: null };
}
