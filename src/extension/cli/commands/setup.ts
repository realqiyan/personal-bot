import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { npmName, ordinaryNpm } from "../../../common/package-source.js";
import { packageRoot } from "../../../common/paths.js";
import { packageVersion } from "../../../common/version.js";
import { PiBootstrapRequired, PiSetup, piPackageName } from "../../../integrations/installation/pi-setup.js";
import { findExecutable, inspectSystem, SetupProcesses } from "../../../integrations/installation/processes.js";
import type { InstalledPackage, SetupPlan } from "../../../model/installation.js";
import { executeSetup, packageChoices, parseCatalog } from "../../../services/installation/setup-service.js";
import { SetupUI } from "../../../ui/setup.js";
import { CliError, requireNoExtraArgs, resolveCliWorkspace, withSignals } from "../args.js";
import type { CliCommand } from "../types.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const setupUsage =
  "用法：pbot setup [--workspace <目录>]\n" +
  "安装或升级 Pi、Personal Bot 和选中的配套插件，然后启动 Pi 执行 /pbot init。";

const installAntigravityUsage =
  "用法：pbot install-antigravity\n" +
  "通过原生 agy plugin install 安装或更新 Antigravity 插件。";

export const setupCommand: CliCommand = {
  name: "setup",
  summary: "交互式安装或升级 Pi 与工作区插件",
  usage: setupUsage,
  updatePolicy: "none",
  supportsWorkspaceFlag: true,
  async run(ctx) {
    requireNoExtraArgs(ctx.args, setupUsage);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError("setup 需要交互终端。请在终端运行 npx personal-bot@latest setup。", 2);
    }
    const outcome = await withSignals(
      async controller => {
        const ui = new SetupUI(controller);
        const processes = new SetupProcesses(controller.signal);
        const cwd = ctx.cwd;
        ui.text("Personal Bot " + packageVersion + " — 安装与升级\n正在检查 Node/npm 和 tmux…");
        const system = await inspectSystem(processes, cwd);
        const supplied = ctx.workspace ?? await ui.ask("工作区目录（当前、已有或新建目录）", cwd);
        const workspace = await resolveCliWorkspace(supplied, cwd);
        const host = new PiSetup(processes, system.npm, cwd);
        let pi = await host.inspectPi();
        let installed: InstalledPackage[];
        try {
          installed = await host.inspectPackages(pi, workspace);
        } catch (error) {
          if (!(error instanceof PiBootstrapRequired)) throw error;
          const version = await host.latest(piPackageName);
          ui.text(error.message + "\n需先安装 Pi 才能使用其原生接口核对这些来源。目标版本：" + version);
          if (!await ui.confirm("先通过 npm 安装 Pi，再继续选择工作区插件")) return 130;
          pi = await host.ensurePi(undefined, version);
          installed = await host.inspectPackages(pi, workspace);
        }
        const catalog = parseCatalog(JSON.parse(await readFile(join(packageRoot, "resources/installer/plugins.json"), "utf8")));
        const choices = packageChoices(catalog, installed);
        const optional = choices.filter(choice => !choice.required);
        ui.text("\nPersonal Bot 必装。选择配套插件（取消勾选不会卸载已有插件）：");
        const selected = await ui.selectMany(
          optional.map(choice => choice.plugin.label + " — " + choice.plugin.description),
          optional.flatMap((choice, index) => choice.selected ? [index] : []),
        );
        optional.forEach((choice, index) => { choice.selected = selected.includes(index); });
        for (const choice of choices.filter(item => item.selected)) {
          if (choice.existing.some(pkg => !ordinaryNpm(pkg.source))) {
            ui.text("\n" + choice.plugin.label + " 的已有来源：\n" + choice.existing.map(pkg =>
              "  " + pkg.scope + ": " + pkg.source + " (" + (pkg.version ?? "版本未知") + ")").join("\n"));
            choice.keep = !await ui.confirm("切换到 npm 最新稳定版", false);
          }
          if (choice.keep) {
            if (choice.existing.length !== 1 || !choice.existing[0]?.installedPath) {
              choice.error = "保留来源未安装或存在多份来源，请先通过 Pi 原生配置处理。";
            }
          } else {
            const others = choice.existing.filter(pkg => !npmName(pkg.source));
            if (others.length > 1 || others.some(pkg => pkg.scope === "user")) {
              choice.error = "请先用 pi config 调整全局或重复来源的加载范围，再切换到 npm。";
            } else {
              try {
                choice.target = await host.latest(npmName(choice.plugin.source)!);
              } catch (error) {
                controller.signal.throwIfAborted();
                choice.error = String(error);
              }
            }
          }
        }
        const plan: SetupPlan = {
          workspace,
          piVersion: await host.latest(piPackageName),
          packages: choices,
          ...(pi ? { pi } : {}),
          ...(system.tmux ? { tmux: system.tmux } : {}),
        };
        ui.text("\n安装计划\n工作区：" + workspace + "\nPi：" + (pi ? pi.command + " (" + pi.version + ")" : "通过 npm 全局安装") + " → " + plan.piVersion);
        if (system.tmux) ui.text("tmux：" + [system.tmux.command, ...system.tmux.args].map(quote).join(" "));
        for (const choice of choices) {
          ui.text("  " + choice.plugin.label + ": " + (!choice.selected ? "本次跳过" : choice.error ??
            (choice.keep ? "保留 " + choice.existing[0]?.source : (choice.existing.map(pkg => pkg.version ?? "未知").join(", ") || "未安装") + " → " + choice.target)));
          if (choice.selected && choice.existing.some(pkg => pkg.filtered)) {
            ui.text("    保留已有资源过滤；如 pbot 被禁用，请通过 pi config --local 启用。");
          }
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
            quote(join(packageRoot, "lib/extension/setup/guard.js")) + " '/pbot init'");
        }
        return failed ? 1 : 0;
      },
      () => console.error("安装已取消；已完成的步骤保留。"),
    );
    return outcome.ok ? outcome.value : outcome.exitCode;
  },
};

export const installAntigravityCommand: CliCommand = {
  name: "install-antigravity",
  summary: "安装或更新 Antigravity 插件",
  usage: installAntigravityUsage,
  updatePolicy: "none",
  async run(ctx) {
    requireNoExtraArgs(ctx.args, installAntigravityUsage);
    const pluginDir = join(packageRoot, "lib/antigravity-plugin");
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
    if (installed.error) {
      console.error(String(installed.error));
      return 1;
    }
    if (installed.status !== 0) return installed.status ?? 1;
    console.log("Antigravity 插件已安装。在目标工作区运行 /pbot init 启用 Personal Bot。");
    return 0;
  },
};
