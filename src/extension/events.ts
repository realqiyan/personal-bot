import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadWorkspaceContext } from "../integrations/agent-resources.js";
import type { Confirmations } from "../ui/confirmation.js";
import type { Lifecycle } from "./lifecycle.js";
import { readWorkspaceConfig, workspaceDisabledMessage } from "../services/workspace/workspace-config.js";
import { workspaceSkillPaths } from "../integrations/pi/skills.js";

export function registerEvents(pi: ExtensionAPI, lifecycle: Lifecycle, confirmations: Confirmations) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await lifecycle.open(ctx.cwd);
      if (!lifecycle.active) {
        ctx.ui.setStatus("pbot", lifecycle.configuration?.error ? "PBot 配置错误" : "PBot 未启用 · /pbot init");
        if (ctx.hasUI && lifecycle.configuration) ctx.ui.notify(workspaceDisabledMessage(lifecycle.configuration), lifecycle.configuration.error ? "error" : "info");
        return;
      }
      ctx.ui.setStatus("pbot", "PBot 已启动");
    } catch (error) {
      ctx.ui.setStatus("pbot", "PBot 启动失败");
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "pbot 启动失败。", "error");
      else throw error;
    }
  });
  pi.on("resources_discover", (_event, ctx) => {
    if (!lifecycle.active) return;
    return { skillPaths: workspaceSkillPaths(pi, ctx.cwd) };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const instance = lifecycle.active;
    if (!instance) return;
    instance.cancelWork();
    try {
      const context = await loadWorkspaceContext({ host: "pi", root: instance.root, role: "coordinator" });
      instance.check();
      Object.assign(event.systemPromptOptions.sections, {
        pbot_workspace: context.workspace,
        pbot_environment: JSON.stringify(context.environment),
        pbot: context.role,
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
  pi.on("session_shutdown", async (event, ctx) => {
    const preserve = event.reason === "reload" && lifecycle.root && (await readWorkspaceConfig(lifecycle.root)).enabled;
    try { await lifecycle.close(Boolean(preserve)); }
    finally { ctx.ui.setStatus("pbot", undefined); }
  });
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
