import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommands, AcpSessionReference } from "../../model/acp.js";
import type { AgentOptions } from "../../model/agent.js";

const targets = {
  pi: { command: "pi-acp", args: [], install: "npm install -g pi-acp",
    configure: "Pi 也需已安装；运行 pi 完成登录和默认模型配置。" },
  dsh: { command: "dsh", args: ["--profile", "acp"], install: "npm install -g @deepseek-ai/dsh@latest",
    configure: "按 dsh 原生方式配置目标 profile 的模型与认证。" },
  claude: { command: "claude-agent-acp", args: [], install: "npm install -g @agentclientprotocol/claude-agent-acp",
    configure: "在 Claude Code 中完成登录或 API 配置，并设置默认模型。" },
};

export function acpExecutable(command: string, backend: AcpBackend): string {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  const target = targets[backend], nativePi = backend === "pi" && command === "pi";
  const install = nativePi ? "npm install -g @earendil-works/pi-coding-agent" : target.install;
  const configured = JSON.stringify({ command: "/absolute/path/to/" + target.command, args: target.args });
  const path = nativePi ? "Pi 已安装但 PATH 不可见时，启动主宿主前将 PI_ACP_PI_COMMAND 设置为 pi 的绝对路径。"
    : "已安装但 PATH 不可见时，在 .pbot/config.json 设置 acp." + backend + "：" + configured + "，command 使用实际绝对路径。";
  throw new Error([
    "未找到 ACP 可执行文件：" + command + "。",
    "在运行 Pi/dsh 的机器上安装：" + install,
    target.configure,
    "检查安装路径：command -v " + (nativePi ? "pi" : target.command) + (!nativePi && backend === "pi" ? "；另用 command -v pi 检查 Pi。" : "。"),
    path,
    "安装后重试原 start 请求；PATH 变化时重启主宿主。配置修改后，Pi 执行 /reload，dsh 重启宿主。",
  ].join("\n"));
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
  const selected = commands[backend] ?? targets[backend];
  return { host: "acp", backend, command: acpExecutable(selected.command, backend), args: [...selected.args], sessionId: null };
}
