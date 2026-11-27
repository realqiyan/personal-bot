import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMcpWorkerTool, type AcpInput } from "../../../model/acp.js";
import { acpMember } from "../../acp/member.js";
import { agentFileTools } from "../../../integrations/hosts/pi/agent-tools.js";
import { toPiMcpConfig } from "../../../integrations/hosts/pi/mcp.js";
import { authorizeMutation } from "../../../services/workspace/workspace-files.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "../../../services/workspace/workspace-mcp.js";
import { resourceRoot } from "../../../common/paths.js";
import { launch } from "../../../storage/agent-files.js";
import { requireThat } from "../../../common/validation.js";

const isBlockedTool = (name: string) => name === "pbot_history" || isMcpWorkerTool(name);

/** Member resources and authoritative final answers; ACP owns input delivery. */
export default async function piAcpMember(pi: ExtensionAPI) {
  const member = await acpMember(), lifetime = new AbortController();
  const registeredMcp: string[] = [];
  let input: AcpInput | undefined, startLeaf: string | null = null;
  const checkSession = (ctx: ExtensionContext) => {
    const reference = member.files.reference(member.id);
    requireThat(reference.host === "acp" && reference.backend === "pi" && realpathSync(ctx.cwd) === member.d.cwd &&
      (reference.sessionId === null || reference.sessionId === ctx.sessionManager.getSessionId()), "Pi ACP 会话身份或工作目录不匹配。");
  };
  const workspaceMcpServers: ReturnType<typeof resolveWorkspaceMcpServer>[] = [];
  if (member.features.mcp && process.env.PBOT_ACP_VALIDATE !== "1") {
    const mcpConfig = await readWorkspaceMcpConfig(member.d.workspace);
    if (!mcpConfig.error) {
      for (const [name, server] of Object.entries(mcpConfig.servers)) {
        if (server.enabled === false) continue;
        try { workspaceMcpServers.push(resolveWorkspaceMcpServer(member.d.workspace, name, server)); }
        catch { /* Leave individual misconfigured servers unavailable without aborting the worker. */ }
      }
    }
  }
  pi.on("resources_discover", async () => {
    if (!member.features.skills || member.d.options.noSkills) return {};
    const skillPaths = [join(resourceRoot, "skills")], workspaceSkills = join(member.d.workspace, ".agents/skills");
    try { if ((await stat(workspaceSkills)).isDirectory()) skillPaths.push(workspaceSkills); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { skillPaths };
  });
  pi.on("session_start", (_event, ctx) => {
    checkSession(ctx);
    const active = pi.getActiveTools();
    for (const tool of agentFileTools(member.d.cwd, lifetime.signal, async (path, change, signal) => {
      member.check(); await authorizeMutation(member.d.workspace, path, change, async () => false, signal); member.check();
    })) pi.registerTool(tool);
    for (const server of workspaceMcpServers) {
      pi.registerMcpServer(server.name, toPiMcpConfig(server));
      registeredMcp.push(server.name);
    }
    pi.setActiveTools(active.filter(name => !isBlockedTool(name)));
    pi.setSessionName(member.files.read(member.id, "launch.json", launch).name);
    startLeaf = ctx.sessionManager.getLeafId();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      checkSession(ctx);
      const current = member.input();
      if (current.requestId !== input?.requestId) { input = current; startLeaf = ctx.sessionManager.getLeafId(); }
      if (!member.features.prompts) return;
      const context = await member.context(); member.check();
      Object.assign(event.systemPromptOptions.sections, { pbot_workspace: context.workspace, pbot_child: context.role, pbot_environment: context.environment });
    } catch (error) { ctx.abort(); throw error; }
  });
  pi.on("tool_call", event => {
    member.check();
    if (isBlockedTool(event.toolName)) return { block: true, reason: "专家不提供协调管理工具。" };
    return;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!input) return;
    const branch = ctx.sessionManager.getBranch(), at = startLeaf === null ? -1 : branch.findIndex(entry => entry.id === startLeaf);
    const last = branch.slice(at + 1).findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    const assistant = last?.type === "message" && last.message.role === "assistant" ? last.message : undefined;
    const answer = assistant?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
    member.answer(input, event.aborted ? "cancelled" : assistant?.stopReason === "stop" ? "completed" : "failed", answer, assistant?.errorMessage);
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_shutdown", () => {
    for (const name of registeredMcp.splice(0)) pi.unregisterMcpServer(name);
    lifetime.abort();
  });
}
