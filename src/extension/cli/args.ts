import { homedir } from "node:os";
import { requireThat } from "../../common/validation.js";
import { resolveWorkspace } from "../../integrations/installation/workspace.js";

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = 1) {
    super(message);
    this.name = "CliError";
  }
}

export interface ExtractedCommonFlags {
  workspace?: string;
  json: boolean;
  help: boolean;
  rest: string[];
}

/** Extract global CLI flags (--workspace, --json, --help/-h) before `--`. */
export function extractCommonFlags(args: readonly string[]): ExtractedCommonFlags {
  const rest: string[] = [];
  let workspace: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (token === "--workspace" || token.startsWith("--workspace=")) {
      if (workspace !== undefined) throw new CliError("--workspace 只能指定一次。", 2);
      const value = token === "--workspace" ? args[++index] : token.slice("--workspace=".length);
      if (!value || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value)) {
        throw new CliError("--workspace 需要目录。", 2);
      }
      workspace = value;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    rest.push(token);
  }
  return {
    ...(workspace !== undefined ? { workspace } : {}),
    json,
    help,
    rest,
  };
}

export function parseKeyValue(raw: string, flag: string): [string, string] {
  const sep = raw.indexOf("=");
  if (sep <= 0) throw new CliError(`${flag} 需要 KEY=VALUE 格式：${raw}`, 2);
  return [raw.slice(0, sep), raw.slice(sep + 1)];
}

export function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? undefined : 2));
}

export function resolveCliWorkspace(workspace: string | undefined, cwd: string): Promise<string> {
  return resolveWorkspace(workspace ?? cwd, cwd, homedir());
}

export function requireNoExtraArgs(args: readonly string[], usage: string): void {
  if (args.length > 0) throw new CliError(`不支持的参数：${args[0]}\n${usage}`, 2);
}

export function requireNonNegativeInt(raw: unknown, flag: string): number {
  requireThat(typeof raw === "string" && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)), `${flag} 需要非负整数。`);
  return Number(raw);
}

export async function withSignals<T>(
  run: (controller: AbortController) => Promise<T>,
  onCancel?: (code: number) => void,
): Promise<{ ok: true; value: T } | { ok: false; exitCode: number }> {
  const controller = new AbortController();
  let signalCode = 0;
  const onInterrupt = () => { signalCode = 130; controller.abort(new Error("操作已取消。")); };
  const onTerminate = () => { signalCode = 143; controller.abort(new Error("操作已取消。")); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return { ok: true, value: await run(controller) };
  } catch (error) {
    if (signalCode || controller.signal.aborted) {
      const code = signalCode || 130;
      onCancel?.(code);
      return { ok: false, exitCode: code };
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
