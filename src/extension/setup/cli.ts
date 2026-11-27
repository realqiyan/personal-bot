import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeSetup, packageChoices, parseCatalog, parseSetupArgs } from "../../services/installation/setup-service.js";
import { npmName, ordinaryNpm } from "../../common/package-source.js";
import type { InstalledPackage, SetupPlan } from "../../services/installation/setup-service.js";
import { PiBootstrapRequired, PiSetup, piPackageName } from "../../integrations/installation/pi-setup.js";
import { findExecutable, inspectSystem, SetupProcesses } from "../../integrations/installation/processes.js";
import { resolveWorkspace } from "../../integrations/installation/workspace.js";
import type { WorkspaceMcpServer } from "../../model/workspace-mcp.js";
import {
  readWorkspaceMcpConfig,
  removeWorkspaceMcpServer,
  upsertWorkspaceMcpServer,
} from "../../services/workspace/workspace-mcp.js";
import { SetupUI } from "../../ui/setup.js";

const root = new URL("../../../", import.meta.url);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const mcpManageUsage =
  "用法：\n" +
  "  pbot mcp list [--workspace <目录>]\n" +
  "  pbot mcp add <name> --url <url> [--header K=V]... [--description <说明>] [--timeout <秒>] [--disabled] [--workspace <目录>]\n" +
  "  pbot mcp add <name> [--env K=V]... [--cwd <目录>] [--description <说明>] [--timeout <秒>] [--disabled] [--workspace <目录>] -- <command> [args...]\n" +
  "  pbot mcp remove <name> [--workspace <目录>]";

function parseKeyValue(raw: string, flag: string): [string, string] {
  const sep = raw.indexOf("=");
  if (sep <= 0) throw new Error(`${flag} 需要 KEY=VALUE 格式：${raw}`);
  return [raw.slice(0, sep), raw.slice(sep + 1)];
}

async function runMcpManage(mcpArgs: string[]): Promise<number> {
  const sub = mcpArgs[0];
  if (!sub || ["--help", "-h"].includes(sub)) {
    console.log(mcpManageUsage);
    return 0;
  }
  const rest = mcpArgs.slice(1);
  if (sub === "list") {
    let workspace: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--workspace") {
        workspace = rest[++i];
        if (!workspace) throw new Error("--workspace 需要目录。");
      } else {
        throw new Error(`未知参数：${rest[i]}\n${mcpManageUsage}`);
      }
    }
    const target = await resolveWorkspace(workspace ?? process.cwd(), process.cwd(), homedir());
    const configuration = await readWorkspaceMcpConfig(target);
    if (configuration.error) throw new Error(configuration.error);
    console.log(JSON.stringify({ workspaceRoot: target, path: configuration.path, mcpServers: configuration.servers }, null, 2));
    return 0;
  }
  if (sub === "remove") {
    const name = rest[0];
    if (!name || name.startsWith("-")) throw new Error(`remove 需要服务名。\n${mcpManageUsage}`);
    let workspace: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--workspace") {
        workspace = rest[++i];
        if (!workspace) throw new Error("--workspace 需要目录。");
      } else {
        throw new Error(`未知参数：${rest[i]}\n${mcpManageUsage}`);
      }
    }
    const target = await resolveWorkspace(workspace ?? process.cwd(), process.cwd(), homedir());
    const result = await removeWorkspaceMcpServer(target, name);
    console.log(JSON.stringify({ workspaceRoot: target, path: result.configuration.path, removed: result.removed, name }, null, 2));
    return result.removed ? 0 : 1;
  }
  if (sub === "add") {
    const name = rest[0];
    if (!name || name.startsWith("-")) throw new Error(`add 需要服务名。\n${mcpManageUsage}`);
    let workspace: string | undefined;
    let url: string | undefined;
    let cwd: string | undefined;
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
      if (arg === "--workspace") {
        workspace = rest[++i];
        if (!workspace) throw new Error("--workspace 需要目录。");
      } else if (arg === "--url") {
        url = rest[++i];
        if (!url) throw new Error("--url 需要地址。");
      } else if (arg === "--cwd") {
        cwd = rest[++i];
        if (!cwd) throw new Error("--cwd 需要目录。");
      } else if (arg === "--description") {
        description = rest[++i];
        if (description === undefined) throw new Error("--description 需要说明文本。");
      } else if (arg === "--timeout") {
        const raw = rest[++i];
        timeout = Number(raw);
        if (!raw || !Number.isInteger(timeout)) throw new Error("--timeout 需要整数秒。");
      } else if (arg === "--disabled") {
        enabled = false;
      } else if (arg === "--env") {
        const raw = rest[++i];
        if (!raw) throw new Error("--env 需要 KEY=VALUE。");
        const [k, v] = parseKeyValue(raw, "--env");
        env[k] = v;
      } else if (arg === "--header") {
        const raw = rest[++i];
        if (!raw) throw new Error("--header 需要 KEY=VALUE。");
        const [k, v] = parseKeyValue(raw, "--header");
        headers[k] = v;
      } else {
        throw new Error(`未知参数：${arg}\n${mcpManageUsage}`);
      }
    }
    const base = {
      ...(description !== undefined ? { description } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    let server: WorkspaceMcpServer;
    if (url !== undefined) {
      if (commandTokens.length || Object.keys(env).length || cwd !== undefined) {
        throw new Error("--url（HTTP）不能与 stdio 命令/--env/--cwd 同时使用。");
      }
      server = {
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...base,
      };
    } else {
      const [command, ...cmdArgs] = commandTokens;
      if (!command) throw new Error(`stdio 服务需要通过 -- <command> [args...] 指定启动命令。\n${mcpManageUsage}`);
      if (Object.keys(headers).length) throw new Error("--header 仅适用于 --url（HTTP）服务。");
      server = {
        command,
        ...(cmdArgs.length ? { args: cmdArgs } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...base,
      };
    }
    const target = await resolveWorkspace(workspace ?? process.cwd(), process.cwd(), homedir());
    const updated = await upsertWorkspaceMcpServer(target, name, server);
    console.log(JSON.stringify({ workspaceRoot: target, path: updated.path, name, server: updated.servers[name] }, null, 2));
    return 0;
  }
  throw new Error(`未知 mcp 子命令：${sub}\n${mcpManageUsage}`);
}

export async function main(args: string[]): Promise<number> {
  let options: ReturnType<typeof parseSetupArgs>;
  try { options = parseSetupArgs(args); }
  catch (error) { console.error(String(error)); return 2; }
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
  if (options.action === "version") { console.log(manifest.version); return 0; }
  if (options.action === "help") {
    console.log("Personal Bot " + manifest.version + "\n\n用法：pbot setup [--workspace <目录>]\n" +
      "      npx personal-bot@latest setup\n" +
      "      pbot install-antigravity\n" +
      "      pbot mcp\n" +
      "      pbot mcp list|add|remove ...\n\n" +
      "setup 安装或升级 Pi、pbot 和选中的插件，然后启动 Pi 执行 /pbot init。\n" +
      "install-antigravity 通过原生 agy plugin install 安装或更新 Antigravity 插件。\n" +
      "mcp 无参数时启动统一 stdio MCP 服务（暴露 worker_* 与 workspace_mcp_*）；带 list/add/remove 时管理工作区 .pbot/mcp.json。\n" +
      "支持 Linux/macOS，需要 Node.js 22.19+ 和 npm。\n--help 显示帮助；--version 显示安装器版本。");
    return 0;
  }
  if (options.action === "mcp-manage") {
    try { return await runMcpManage(options.mcpArgs ?? []); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  }
  if (options.action === "mcp") {
    const entry = fileURLToPath(new URL("lib/extension/mcp.js", root));
    if (!existsSync(entry)) {
      console.error("缺少 MCP 构建产物：" + entry + "。请先运行 npm run build。");
      return 1;
    }
    const child = spawnSync(process.execPath, [entry], { stdio: "inherit" });
    if (child.error) { console.error(String(child.error)); return 1; }
    return child.status ?? 0;
  }
  if (options.action === "install-antigravity") {
    const pluginDir = fileURLToPath(new URL("lib/antigravity-plugin", root));
    if (!existsSync(join(pluginDir, "plugin.json"))) {
      console.error("缺少 Antigravity 插件构建产物：" + pluginDir + "。请先运行 npm run build。");
      return 1;
    }
    const agy = process.env.PBOT_AGY_COMMAND || await findExecutable("agy", process.env);
    if (!agy) {
      console.error("未找到 Antigravity CLI（agy）。请先安装 agy，然后运行：\n  agy plugin install " + quote(pluginDir));
      return 1;
    }
    const installed = spawnSync(agy, ["plugin", "install", pluginDir], { stdio: "inherit" });
    if (installed.error) { console.error(String(installed.error)); return 1; }
    if (installed.status !== 0) return installed.status ?? 1;
    console.log("Antigravity 插件已安装。在目标工作区运行 /pbot init 启用 Personal Bot。");
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("setup 需要交互终端。请在终端运行 npx personal-bot@latest setup。"); return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("安装已取消；已完成的步骤保留。"));
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const ui = new SetupUI(controller), processes = new SetupProcesses(controller.signal);
  try {
    const cwd = process.cwd();
    ui.text("Personal Bot " + manifest.version + " — 安装与升级\n正在检查 Node/npm 和 tmux…");
    const system = await inspectSystem(processes, cwd);
    const supplied = options.workspace ?? await ui.ask("工作区目录（当前、已有或新建目录）", cwd);
    const workspace = await resolveWorkspace(supplied, cwd, homedir());
    const host = new PiSetup(processes, system.npm, cwd);
    let pi = await host.inspectPi();
    let installed: InstalledPackage[];
    try { installed = await host.inspectPackages(pi, workspace); }
    catch (error) {
      if (!(error instanceof PiBootstrapRequired)) throw error;
      const version = await host.latest(piPackageName);
      ui.text(error.message + "\n需先安装 Pi 才能使用其原生接口核对这些来源。目标版本：" + version);
      if (!await ui.confirm("先通过 npm 安装 Pi，再继续选择工作区插件")) return 130;
      pi = await host.ensurePi(undefined, version);
      installed = await host.inspectPackages(pi, workspace);
    }
    const catalog = parseCatalog(JSON.parse(await readFile(new URL("resources/installer/plugins.json", root), "utf8")));
    const choices = packageChoices(catalog, installed), optional = choices.filter(choice => !choice.required);
    ui.text("\nPersonal Bot 必装。选择配套插件（取消勾选不会卸载已有插件）：");
    const selected = await ui.selectMany(optional.map(choice => choice.plugin.label + " — " + choice.plugin.description),
      optional.flatMap((choice, index) => choice.selected ? [index] : []));
    optional.forEach((choice, index) => { choice.selected = selected.includes(index); });
    for (const choice of choices.filter(item => item.selected)) {
      if (choice.existing.some(pkg => !ordinaryNpm(pkg.source))) {
        ui.text("\n" + choice.plugin.label + " 的已有来源：\n" + choice.existing.map(pkg =>
          "  " + pkg.scope + ": " + pkg.source + " (" + (pkg.version ?? "版本未知") + ")").join("\n"));
        choice.keep = !await ui.confirm("切换到 npm 最新稳定版", false);
      }
      if (choice.keep) {
        if (choice.existing.length !== 1 || !choice.existing[0]?.installedPath) choice.error = "保留来源未安装或存在多份来源，请先通过 Pi 原生配置处理。";
      } else {
        const others = choice.existing.filter(pkg => !npmName(pkg.source));
        if (others.length > 1 || others.some(pkg => pkg.scope === "user")) {
          choice.error = "请先用 pi config 调整全局或重复来源的加载范围，再切换到 npm。";
        } else {
          try { choice.target = await host.latest(npmName(choice.plugin.source)!); }
          catch (error) { controller.signal.throwIfAborted(); choice.error = String(error); }
        }
      }
    }
    const plan: SetupPlan = { workspace, piVersion: await host.latest(piPackageName), packages: choices,
      ...(pi ? { pi } : {}), ...(system.tmux ? { tmux: system.tmux } : {}) };
    ui.text("\n安装计划\n工作区：" + workspace + "\nPi：" + (pi ? pi.command + " (" + pi.version + ")" : "通过 npm 全局安装") + " → " + plan.piVersion);
    if (system.tmux) ui.text("tmux：" + [system.tmux.command, ...system.tmux.args].map(quote).join(" "));
    for (const choice of choices) {
      ui.text("  " + choice.plugin.label + ": " + (!choice.selected ? "本次跳过" : choice.error ??
        (choice.keep ? "保留 " + choice.existing[0]?.source : (choice.existing.map(pkg => pkg.version ?? "未知").join(", ") || "未安装") + " → " + choice.target)));
      if (choice.selected && choice.existing.some(pkg => pkg.filtered)) ui.text("    保留已有资源过滤；如 pbot 被禁用，请通过 pi config --local 启用。");
    }
    const blocking = choices.find(choice => choice.required && choice.error);
    if (blocking) throw new Error(blocking.error);
    ui.text("升级前请停止活动 pbot 子会话。Pi 为当前用户共用，插件只处理此工作区。");
    if (!await ui.confirm("执行以上计划")) return 130;
    await mkdir(workspace, { recursive: true });
    if (await realpath(workspace) !== workspace) throw new Error("工作区路径已发生变化，请重新运行 setup。");
    const result = await executeSetup(plan, host, item => ui.text("[" + item.state + "] " + item.name + ": " + item.detail), controller.signal);
    const failed = result.results.some(item => item.state === "failed");
    if (!result.pi) return 1;
    ui.text("\n软件安装阶段结束。工作区初始化和外部服务的状态由 Pi/pbot/插件分别报告。");
    if (await ui.confirm(failed ? "部分插件失败，是否仍启动 Pi 并初始化启用工作区" : "启动 Pi 并初始化启用工作区", !failed)) {
      process.stdin.pause();
      await host.start(result.pi, workspace);
    } else {
      ui.text("稍后执行：\ncd " + quote(workspace) + "\n" + quote(result.pi.command) + " --extension " +
        quote(fileURLToPath(new URL("extension/setup/guard.js", new URL("../../", import.meta.url)))) + " '/pbot init'");
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }
}
