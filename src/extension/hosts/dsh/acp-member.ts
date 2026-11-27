import type { Context } from "@deepseek-ai/cordis";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import type { AcpInput } from "../../../model/acp.js";
import { acpMember } from "../../acp/member.js";
import { rootAgents } from "../../../integrations/hosts/dsh/root-agents.js";
import { dshResources, dshExpertTools } from "../../../integrations/hosts/dsh/resources.js";
import { registerDshSkills } from "../../../integrations/hosts/dsh/skills.js";
import { toDshMcpConfig } from "../../../integrations/hosts/dsh/mcp.js";
import { finalDshAnswer } from "../../../integrations/hosts/dsh/messages.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServer } from "../../../services/workspace/workspace-mcp.js";
import { registerDshFileEvents } from "./files.js";
import { requireThat } from "../../../common/validation.js";

export const name = "pbot-acp-member";
export const inject = ["agents", "sessions", "llm", "tools", "systemPrompt", "skills", "fs", "workingDirectory", "approval"];

export async function apply(ctx: Context) {
  const member = await acpMember();
  ctx.on("agent/pre-step", async (_event, next) => {
    if (process.env.PBOT_ACP_VALIDATE === "1") return { kind: "reject" };
    member.input(); return next();
  });
  ctx.on("agent/created", async ({ agent, source }) => {
    if (!rootAgents(ctx.agents).includes(agent)) return;
    if (source === "resume") agent.inbox.clear();
    const reference = member.files.reference(member.id);
    requireThat(reference.host === "acp" && reference.backend === "dsh" && agent.session.header.cwd === member.d.cwd &&
      (reference.sessionId === null || reference.sessionId === agent.id), "dsh ACP 会话身份或工作目录不匹配。");
    await agent.ctx.plugin({ name: "pbot-acp-expert", inject, apply: async scope => {
      if (member.features.skills) registerDshSkills(scope, agent, { workspaceRoot: member.d.workspace });
      if (member.features.mcp && process.env.PBOT_ACP_VALIDATE !== "1") {
        const mcpConfig = await readWorkspaceMcpConfig(member.d.workspace);
        if (mcpConfig.error) {
          ctx.logger.warn(mcpConfig.error);
        } else {
          for (const [serverName, server] of Object.entries(mcpConfig.servers)) {
            if (server.enabled === false) continue;
            try {
              const resolved = resolveWorkspaceMcpServer(member.d.workspace, serverName, server);
              await scope.plugin(McpClient, toDshMcpConfig(resolved));
            } catch (error) {
              ctx.logger.warn(error instanceof Error ? error.message : String(error));
            }
          }
        }
      }
      dshExpertTools(scope, agent, member.d.options);
      if (member.features.prompts) await dshResources(scope, agent, member.d.workspace, "general-purpose", member.check);
      registerDshFileEvents(scope, agent, member.d.workspace, true, member.check);
      let input: AcpInput | undefined, answer = "";
      scope.on("session/event", (session, event) => {
        if (session !== agent.session) return;
        if (event.type === "turn/start") { input = member.input(); answer = ""; }
        if (event.type === "assistant/message") answer = finalDshAnswer(event);
        if (event.type === "turn/end" && input) {
          const reason = event.data.reason;
          member.answer(input, reason.kind === "completed" && answer.trim() ? "completed" : reason.kind === "aborted" ? "cancelled" : "failed", answer,
            reason.kind === "error" ? reason.error.message : reason.kind === "completed" ? undefined : reason.kind);
        }
      });
    } });
  });
}
