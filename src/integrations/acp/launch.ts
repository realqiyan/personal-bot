import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { isAcpBackend, requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommands, AcpSessionReference, BuiltinAcpBackend } from "../../model/acp.js";
import type { AgentOptions } from "../../model/agent.js";

interface BuiltinTarget {
  command: string;
  args: string[];
  install: string;
  configure: string;
}

const targets: Record<BuiltinAcpBackend, BuiltinTarget> = {
  pi: {
    command: "pi-acp",
    args: [],
    install: "npm install -g pi-acp",
    configure: "Pi 也需已安装；运行 pi 完成登录和默认模型配置。",
  },
  dsh: {
    command: "dsh",
    args: ["--profile", "acp"],
    install: "npm install -g @deepseek-ai/dsh@latest",
    configure: "按 dsh 原生方式配置目标 profile 的模型与认证。",
  },
  claude: {
    command: "claude-agent-acp",
    args: [],
    install: "npm install -g @agentclientprotocol/claude-agent-acp",
    configure: "在 Claude Code 中完成登录或 API 配置，并设置默认模型。",
  },
  antigravity: {
    command: "agy",
    args: ["acp"],
    install: "安装 Google Antigravity CLI（agy）",
    configure: "运行 agy 完成登录与默认模型配置。",
  },
  codex: {
    command: "codex-acp",
    args: [],
    install: "npm install -g @zed-industries/codex-acp",
    configure: "在 Codex 中完成登录或 API 配置。",
  },
};

export const builtinAcpBackends = Object.keys(targets) as BuiltinAcpBackend[];

function isBuiltin(backend: string): backend is BuiltinAcpBackend {
  return Object.hasOwn(targets, backend);
}

export function findAcpExecutable(command: string): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return undefined;
}

export function acpExecutable(command: string, backend: AcpBackend): string {
  const found = findAcpExecutable(command);
  if (found) return found;
  const target = isBuiltin(backend) ? targets[backend] : undefined;
  const nativePi = backend === "pi" && command === "pi";
  const install = nativePi
    ? "npm install -g @earendil-works/pi-coding-agent"
    : target?.install ?? `请确认 ${backend} 对应的 ACP 可执行文件已安装。`;
  const configured = JSON.stringify({ command: "/absolute/path/to/" + (target?.command ?? command), args: target?.args ?? [] });
  const path = nativePi
    ? "Pi 已安装但 PATH 不可见时，启动主宿主前将 PI_ACP_PI_COMMAND 设置为 pi 的绝对路径。"
    : "已安装但 PATH 不可见时，在 .pbot/config.json 设置 acp." + backend + "：" + configured + "，command 使用实际绝对路径。";
  throw new Error([
    "未找到子代理程序：" + command + "。",
    "安装提示：" + install,
    ...(target ? [target.configure] : []),
    "检查安装路径：command -v " + (nativePi ? "pi" : (target?.command ?? command)) + (!nativePi && backend === "pi" ? "；另用 command -v pi 检查 Pi。" : "。"),
    path,
    "安装后重试原 start 请求；PATH 变化时重启主宿主。配置修改后，Pi 执行 /reload，dsh 重启宿主。",
  ].join("\n"));
}

export function inspectAcpBackends(commands: AcpCommands = {}) {
  const names = [...new Set([...builtinAcpBackends, ...Object.keys(commands)])];
  return names.map(backend => {
    const selected = commands[backend] ?? (isBuiltin(backend) ? targets[backend] : undefined)!;
    const resolved = findAcpExecutable(selected.command);
    return {
      backend,
      builtin: isBuiltin(backend),
      configured: Object.hasOwn(commands, backend),
      command: selected.command,
      args: [...selected.args],
      available: Boolean(resolved),
      ...(resolved ? { resolvedCommand: resolved } : {}),
    };
  });
}

export function acpLaunch(backend: AcpBackend, commands: AcpCommands, options: AgentOptions): AcpSessionReference {
  requireThat(isAcpBackend(backend), "未知子代理程序：" + String(backend));
  const selected = commands[backend] ?? (isBuiltin(backend) ? targets[backend] : undefined);
  requireThat(selected, `未知子代理程序：${backend}。内置目标：${builtinAcpBackends.join(", ")}；自定义目标请在 .pbot/config.json 的 acp 字段中配置。`);
  requireThat(!options.provider || options.model, "provider 需要同时指定目标 model。");
  if (backend !== "pi") for (const key of ["noExtensions", "noPromptTemplates", "noContextFiles"] as const) {
    requireThat(options[key] === undefined, backend + " 子代理不支持启动选项：" + key);
  }
  if (backend === "claude") {
    requireThat(options.noSkills === undefined && options.tools === undefined, "Claude 子代理的技能和工具通过 Claude 原生配置选择。");
    requireThat(options.provider === undefined, "Claude 子代理使用原生提供方配置；请仅指定目标 model。");
  }
  return { host: "acp", backend, command: acpExecutable(selected.command, backend), args: [...selected.args], sessionId: null };
}
