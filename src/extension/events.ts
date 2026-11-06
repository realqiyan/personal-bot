import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resourceRoot } from "../common/paths.js";
import { agentText } from "../integrations/agent-resources.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";

export function registerEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await lifecycle.open(ctx.cwd);
      if (ctx.mode === "tui") ctx.ui.setStatus("pbot-python", "Python 准备中");
      else ctx.ui.notify("正在准备共享 Python 环境；首次安装可能需要数分钟。", "info");
      try { await lifecycle.get().preparePython(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "tui") ctx.ui.notify("Python 未就绪；/pbot status 查看详情。", "warning");
        else if (ctx.hasUI) ctx.ui.notify(message, "warning"); else console.error(message);
      } finally { if (ctx.mode === "tui") ctx.ui.setStatus("pbot-python", undefined); }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "pbot 启动失败。", "error");
      else throw error;
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance) return;
    instance.cancelWork();
    try {
      const role = await agentText("coordinator", instance.root);
      const workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
      instance.check();
      const { state, directory } = instance.pythonEnvironment.status;
      Object.assign(event.systemPromptOptions.sections, {
        pbot_workspace: workspace,
        pbot_environment: JSON.stringify({ workspaceRoot: instance.root, resourceRoot, python: { state, directory } }),
        pbot: role,
      });
    } catch (error) {
      // Pi reports hook errors but continues preparation unless the run is explicitly aborted.
      ctx.abort(); throw error;
    }
  });
  pi.on("input", () => { lifecycle.active?.cancelWork(); });
  pi.on("agent_end", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_switch", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_fork", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_before_tree", () => { lifecycle.active?.cancelWork(); });
  pi.on("session_shutdown", event => lifecycle.close(event.reason === "reload"));
  pi.on("tool_call", async (event, ctx) => {
    const instance = lifecycle.active;
    if (["write", "edit"].includes(event.toolName) && "path" in event.input && typeof event.input.path === "string") {
      const path = event.input.path.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
      const expanded = /^file:\/\//.test(path) ? fileURLToPath(path)
        : path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
      const target = resolve(ctx.cwd, expanded);
      if (!instance) return;
      const cancel = instance.signal(ctx.signal);
      try {
        await instance.authorizeFile(target, event.input,
          value => confirmations.ask(ctx, "确认修改工作区外文件", value, cancel), cancel);
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    return;
  });
}
