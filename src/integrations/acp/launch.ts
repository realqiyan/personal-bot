import { isAcpBackend, requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommands, AcpSessionReference, AcpStartOptions } from "../../model/acp.js";
import { acpExecutable, findAcpExecutable } from "./executable.js";
import { acpHarnesses, resolveAcpHarness } from "./registry.js";

export { acpExecutable, findAcpExecutable } from "./executable.js";

export function inspectAcpBackends(commands: AcpCommands = {}) {
  const names = [...new Set([...acpHarnesses.list(), ...Object.keys(commands)])];
  return names.flatMap(backend => {
    const harness = acpHarnesses.get(backend);
    const selected = commands[backend] ?? harness?.defaultCommand;
    if (!selected) return [];
    const resolved = findAcpExecutable(selected.command);
    return [{
      backend,
      builtin: Boolean(harness?.defaultCommand),
      configured: Object.hasOwn(commands, backend),
      command: selected.command,
      args: [...selected.args],
      available: Boolean(resolved),
      ...(resolved ? { resolvedCommand: resolved } : {}),
    }];
  });
}

export function filterAcpStartOptions(backend: AcpBackend, options: AcpStartOptions): AcpStartOptions {
  const harness = resolveAcpHarness(backend);
  return harness.filterStartOptions ? harness.filterStartOptions(options) : { ...options };
}

export function acpLaunch(backend: AcpBackend, commands: AcpCommands, options: AcpStartOptions): AcpSessionReference {
  requireThat(isAcpBackend(backend), "未知子代理程序：" + String(backend));
  const harness = resolveAcpHarness(backend);
  const selected = commands[backend] ?? harness.defaultCommand;
  requireThat(selected, `未知子代理程序：${backend}。已注册目标：${acpHarnesses.list().join(", ")}；自定义目标请在 .pbot/config.json 的 acp 字段中配置。`);
  requireThat(!options.provider || options.model, "provider 需要同时指定目标 model。");
  harness.validateStartOptions?.(options);
  return {
    host: "acp",
    backend,
    command: acpExecutable(selected.command, backend, harness),
    args: [...selected.args],
    ...(selected.env ? { env: { ...selected.env } } : {}),
    sessionId: null,
  };
}
