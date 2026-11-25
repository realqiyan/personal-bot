import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { AcpBackend, AcpHarnessAdapter } from "../../model/acp.js";

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

export function acpExecutable(command: string, backend: AcpBackend, harness?: AcpHarnessAdapter): string {
  const found = findAcpExecutable(command);
  if (found) return found;
  const nativePi = backend === "pi" && command === "pi";
  const targetCommand = harness?.defaultCommand?.command ?? command;
  const targetArgs = harness?.defaultCommand?.args ?? [];
  const install = nativePi
    ? "npm install -g @earendil-works/pi-coding-agent"
    : harness?.installHint ?? `请确认 ${backend} 对应的 ACP 可执行文件已安装。`;
  const configured = JSON.stringify({ command: "/absolute/path/to/" + targetCommand, args: targetArgs });
  const pathHint = nativePi
    ? "Pi 已安装但 PATH 不可见时，启动主宿主前将 PI_ACP_PI_COMMAND 设置为 pi 的绝对路径。"
    : "已安装但 PATH 不可见时，在 .pbot/config.json 设置 acp." + backend + "：" + configured + "，command 使用实际绝对路径。";
  throw new Error([
    "未找到子代理程序：" + command + "。",
    "安装提示：" + install,
    ...(harness?.configureHint ? [harness.configureHint] : []),
    "检查安装路径：command -v " + (nativePi ? "pi" : targetCommand) + (!nativePi && backend === "pi" ? "；另用 command -v pi 检查 Pi。" : "。"),
    pathHint,
    "安装后重试原 start 请求；PATH 变化时重启主宿主。配置修改后，Pi 执行 /reload，dsh 重启宿主。",
  ].join("\n"));
}
