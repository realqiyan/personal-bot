import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../../../common/paths.js";
import { pluginMcpWorkspaceRoot } from "../../../integrations/hosts/plugin-registry.js";
import type { WorkspaceMcpServer } from "../../../model/workspace-mcp.js";
import {
  readWorkspaceMcpConfig,
  removeWorkspaceMcpServer,
  upsertWorkspaceMcpServer,
} from "../../../services/workspace/workspace-mcp.js";
import { CliError, parseKeyValue, printJson, resolveCliWorkspace } from "../args.js";
import type { CliCommand } from "../types.js";

const mcpUsage =
  "用法：\n" +
  "  pbot mcp\n" +
  "  pbot mcp list [--workspace <目录>] [--json]\n" +
  "  pbot mcp add <name> --url <url> [--header K=V]... [--description <说明>] [--timeout <秒>] [--disabled] [--workspace <目录>]\n" +
  "  pbot mcp add <name> [--env K=V]... [--cwd <目录>] [--description <说明>] [--timeout <秒>] [--disabled] [--workspace <目录>] -- <command> [args...]\n" +
  "  pbot mcp remove <name> [--workspace <目录>]\n\n" +
  "无参数时启动统一 stdio MCP 服务（暴露 worker_* 与 workspace_mcp_*）；带 list/add/remove 时管理工作区 .pbot/mcp.json。";

async function runMcpServer(): Promise<number> {
  const entry = join(packageRoot, "lib/extension/mcp.js");
  if (!existsSync(entry)) {
    console.error("缺少 MCP 构建产物：" + entry + "。请先运行 npm run build。");
    return 1;
  }
  const child = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  if (child.error) {
    console.error(String(child.error));
    return 1;
  }
  return child.status ?? 0;
}

async function runMcpManage(args: string[], workspace: string | undefined, cwd: string, compact: boolean): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    if (rest.length > 0) throw new CliError(`未知参数：${rest[0]}\n${mcpUsage}`, 2);
    const target = await resolveCliWorkspace(workspace, cwd);
    const configuration = await readWorkspaceMcpConfig(target);
    if (configuration.error) throw new CliError(configuration.error, 2);
    printJson({ workspaceRoot: target, path: configuration.path, mcpServers: configuration.servers }, compact);
    return 0;
  }
  if (sub === "remove") {
    const name = rest[0];
    if (!name || name.startsWith("-")) throw new CliError(`remove 需要服务名。\n${mcpUsage}`, 2);
    if (rest.length > 1) throw new CliError(`未知参数：${rest[1]}\n${mcpUsage}`, 2);
    const target = await resolveCliWorkspace(workspace, cwd);
    const result = await removeWorkspaceMcpServer(target, name);
    printJson({ workspaceRoot: target, path: result.configuration.path, removed: result.removed, name }, compact);
    return result.removed ? 0 : 1;
  }
  if (sub === "add") {
    const name = rest[0];
    if (!name || name.startsWith("-")) throw new CliError(`add 需要服务名。\n${mcpUsage}`, 2);
    let url: string | undefined;
    let serverCwd: string | undefined;
    let description: string | undefined;
    let timeout: number | undefined;
    let enabled: boolean | undefined;
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    let commandTokens: string[] = [];
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--") {
        commandTokens = rest.slice(i + 1);
        break;
      }
      if (arg === "--url") {
        url = rest[++i];
        if (!url) throw new CliError("--url 需要地址。", 2);
      } else if (arg === "--cwd") {
        serverCwd = rest[++i];
        if (!serverCwd) throw new CliError("--cwd 需要目录。", 2);
      } else if (arg === "--description") {
        description = rest[++i];
        if (description === undefined) throw new CliError("--description 需要说明文本。", 2);
      } else if (arg === "--timeout") {
        const raw = rest[++i];
        timeout = Number(raw);
        if (!raw || !Number.isInteger(timeout)) throw new CliError("--timeout 需要整数秒。", 2);
      } else if (arg === "--disabled") {
        enabled = false;
      } else if (arg === "--env") {
        const raw = rest[++i];
        if (!raw) throw new CliError("--env 需要 KEY=VALUE。", 2);
        const [k, v] = parseKeyValue(raw, "--env");
        env[k] = v;
      } else if (arg === "--header") {
        const raw = rest[++i];
        if (!raw) throw new CliError("--header 需要 KEY=VALUE。", 2);
        const [k, v] = parseKeyValue(raw, "--header");
        headers[k] = v;
      } else {
        throw new CliError(`未知参数：${arg}\n${mcpUsage}`, 2);
      }
    }
    const base = {
      ...(description !== undefined ? { description } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    let server: WorkspaceMcpServer;
    if (url !== undefined) {
      if (commandTokens.length || Object.keys(env).length || serverCwd !== undefined) {
        throw new CliError("--url（HTTP）不能与 stdio 命令/--env/--cwd 同时使用。", 2);
      }
      server = {
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...base,
      };
    } else {
      const [command, ...cmdArgs] = commandTokens;
      if (!command) throw new CliError(`stdio 服务需要通过 -- <command> [args...] 指定启动命令。\n${mcpUsage}`, 2);
      if (Object.keys(headers).length) throw new CliError("--header 仅适用于 --url（HTTP）服务。", 2);
      server = {
        command,
        ...(cmdArgs.length ? { args: cmdArgs } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(serverCwd !== undefined ? { cwd: serverCwd } : {}),
        ...base,
      };
    }
    const target = await resolveCliWorkspace(workspace, cwd);
    const updated = await upsertWorkspaceMcpServer(target, name, server);
    printJson({ workspaceRoot: target, path: updated.path, name, server: updated.servers[name] }, compact);
    return 0;
  }
  throw new CliError(`未知 mcp 子命令：${sub}\n${mcpUsage}`, 2);
}

export const mcpCommand: CliCommand = {
  name: "mcp",
  summary: "启动统一 stdio MCP 服务或管理工作区 .pbot/mcp.json",
  usage: mcpUsage,
  updatePolicy: "workspace",
  supportsWorkspaceFlag: true,
  supportsJsonFlag: true,
  beforeUpdate(ctx) {
    if (ctx.args.length === 0 && (ctx.workspace !== undefined || ctx.json)) {
      throw new CliError(`启动 MCP 服务时不接受 --workspace 或 --json 参数。\n${mcpUsage}`, 2);
    }
  },
  async resolveWorkspaceRoot(ctx) {
    if (ctx.args.length === 0 && !ctx.workspace) {
      return resolveCliWorkspace(pluginMcpWorkspaceRoot() ?? ctx.cwd, ctx.cwd);
    }
    return resolveCliWorkspace(ctx.workspace, ctx.cwd);
  },
  async run(ctx) {
    if (ctx.args.length === 0) {
      if (ctx.workspace !== undefined || ctx.json) {
        throw new CliError(`启动 MCP 服务时不接受 --workspace 或 --json 参数。\n${mcpUsage}`, 2);
      }
      return runMcpServer();
    }
    return runMcpManage(ctx.args, ctx.workspace, ctx.cwd, ctx.json);
  },
};
