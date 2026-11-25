import { isAcpBackend, requireThat } from "../../common/validation.js";
import type { AcpBackend, AcpCommand, AcpCommands, AcpPermissionPolicy, AcpSessionReference, AcpStartOptions } from "../../model/acp.js";
import { acpExecutable, findAcpExecutable } from "./executable.js";
import { acpHarnesses, resolveAcpHarness } from "./registry.js";

export { acpExecutable, findAcpExecutable } from "./executable.js";

/** Workspace entries override a registered default command; an entry without `command` only adjusts env or permission. */
export function configuredAcpCommand(backend: AcpBackend, commands: AcpCommands = {}): AcpCommand | undefined {
  const entry = Object.hasOwn(commands, backend) ? commands[backend] : undefined;
  const base = entry?.command ? { command: entry.command, args: entry.args ?? [] } : acpHarnesses.get(backend)?.defaultCommand;
  if (!base) return undefined;
  const env = { ...base.env, ...entry?.env };
  return { command: base.command, args: [...base.args], ...(Object.keys(env).length ? { env } : {}) };
}

export function acpPermissionPolicy(backend: AcpBackend, commands: AcpCommands = {}): AcpPermissionPolicy {
  return (Object.hasOwn(commands, backend) ? commands[backend]?.permission : undefined) ?? "ask";
}

/** Names callers may use: registered harnesses plus workspace-configured custom harnesses. */
export function knownAcpBackends(commands: AcpCommands = {}): AcpBackend[] {
  return [...new Set([...acpHarnesses.list(), ...Object.keys(commands)])].filter(backend => configuredAcpCommand(backend, commands));
}

export function canonicalAcpBackend(name: string, commands: AcpCommands = {}): AcpBackend {
  return acpHarnesses.canonical(name, Object.keys(commands));
}

export function inspectAcpBackends(commands: AcpCommands = {}) {
  return knownAcpBackends(commands).map(backend => {
    const harness = acpHarnesses.get(backend);
    const selected = configuredAcpCommand(backend, commands)!;
    const resolved = findAcpExecutable(selected.command);
    return {
      backend,
      ...(harness?.label ? { label: harness.label } : {}),
      ...(harness?.aliases?.length ? { aliases: [...harness.aliases] } : {}),
      available: Boolean(resolved),
      builtin: Boolean(harness?.defaultCommand),
      configured: Object.hasOwn(commands, backend),
      permission: acpPermissionPolicy(backend, commands),
      command: selected.command,
      args: [...selected.args],
      ...(resolved ? { resolvedCommand: resolved } : { installHint: harness?.installHint ?? "在 .pbot/config.json 的 acp 字段配置可执行命令。" }),
    };
  });
}

export function filterAcpStartOptions(backend: AcpBackend, options: AcpStartOptions): AcpStartOptions {
  const harness = resolveAcpHarness(backend);
  return harness.filterStartOptions ? harness.filterStartOptions(options) : { ...options };
}

export function acpLaunch(backend: AcpBackend, commands: AcpCommands, options: AcpStartOptions): AcpSessionReference {
  requireThat(isAcpBackend(backend), "未知子代理程序：" + String(backend));
  const harness = resolveAcpHarness(backend);
  const selected = configuredAcpCommand(backend, commands);
  requireThat(selected, `未知子代理程序：${backend}。可用目标：${knownAcpBackends(commands).join(", ")}；自定义目标请在 .pbot/config.json 的 acp 字段中配置。`);
  requireThat(!options.provider || options.model, "provider 需要同时指定目标 model。");
  harness.validateStartOptions?.(options);
  const permission = acpPermissionPolicy(backend, commands);
  return {
    host: "acp",
    backend,
    command: acpExecutable(selected.command, backend, harness),
    args: [...selected.args],
    ...(selected.env ? { env: { ...selected.env } } : {}),
    ...(permission !== "ask" ? { permission } : {}),
    sessionId: null,
  };
}
