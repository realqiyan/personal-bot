import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { executeSetup, packageChoices, parseCatalog, parseSetupArgs } from "../services/installation/setup-service.js";
import { npmName, ordinaryNpm } from "../common/package-source.js";
import type { InstalledPackage, SetupPlan } from "../services/installation/setup-service.js";
import { PiBootstrapRequired, PiSetup, piPackageName } from "../integrations/installation/pi-setup.js";
import { inspectSystem, SetupProcesses } from "../integrations/installation/processes.js";
import { resolveWorkspace } from "../integrations/installation/workspace.js";
import { SetupUI } from "../ui/setup.js";

const root = new URL("../../", import.meta.url);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function main(args: string[]): Promise<number> {
  let options: ReturnType<typeof parseSetupArgs>;
  try { options = parseSetupArgs(args); }
  catch (error) { console.error(String(error)); return 2; }
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
  if (options.action === "version") { console.log(manifest.version); return 0; }
  if (options.action === "help") {
    console.log("Personal Bot " + manifest.version + "\n\n用法：pbot setup [--workspace <目录>]\n" +
      "      npx personal-bot@latest setup\n\nsetup 安装或升级 Pi、pbot 和选中的插件，然后启动 Pi 执行 /pbot init。\n" +
      "支持 Linux/macOS，需要 Node.js 22.19+、npm 和 Python 3.11+。\n--help 显示帮助；--version 显示安装器版本。");
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
    ui.text("Personal Bot " + manifest.version + " — 安装与升级\n正在检查 Node/npm、Python 和 tmux…");
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
    ui.text("升级前请停止活动 pbot 子会话和相关 Python 脚本。Pi 为当前用户共用，插件只处理此工作区。");
    if (!await ui.confirm("执行以上计划")) return 130;
    await mkdir(workspace, { recursive: true });
    if (await realpath(workspace) !== workspace) throw new Error("工作区路径已发生变化，请重新运行 setup。");
    const result = await executeSetup(plan, host, item => ui.text("[" + item.state + "] " + item.name + ": " + item.detail), controller.signal);
    const failed = result.results.some(item => item.state === "failed");
    if (!result.pi) return 1;
    ui.text("\n软件安装阶段结束。初始化、Python 环境和外部服务的状态由 Pi/pbot/插件分别报告。");
    if (await ui.confirm(failed ? "部分插件失败，是否仍启动 Pi 并初始化启用工作区" : "启动 Pi 并初始化启用工作区", !failed)) {
      process.stdin.pause();
      await host.start(result.pi, workspace);
    } else {
      ui.text("稍后执行：\ncd " + quote(workspace) + "\n" + quote(result.pi.command) + " --extension " +
        quote(fileURLToPath(new URL("extension/setup-guard.js", new URL("../", import.meta.url)))) + " '/pbot init'");
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }
}
