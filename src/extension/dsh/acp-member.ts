import type { Context } from "@deepseek-ai/cordis";
import type { AcpInput } from "../../model/acp.js";
import { acpMember } from "../acp-member.js";
import { dshResources, dshExpertTools } from "../../integrations/dsh/resources.js";
import { registerDshSkills } from "../../integrations/dsh/skills.js";
import { finalDshAnswer } from "../../integrations/dsh/messages.js";
import { registerDshFileEvents } from "./files.js";
import { requireThat } from "../../common/validation.js";

export const name = "pbot-acp-member";
export const inject = ["agents", "sessions", "llm", "tools", "systemPrompt", "skills", "fs", "workingDirectory", "approval"];

export async function apply(ctx: Context) {
  const member = await acpMember();
  ctx.on("agent/pre-step", async (_event, next) => {
    if (process.env.PBOT_ACP_VALIDATE === "1") return { kind: "reject" };
    member.input(); return next();
  });
  ctx.on("agent/created", async ({ agent, source }) => {
    if (!ctx.agents.roots().includes(agent)) return;
    if (source === "resume") agent.inbox.clear();
    const reference = member.files.reference(member.id);
    requireThat(reference.host === "acp" && reference.backend === "dsh" && agent.session.header.cwd === member.d.cwd &&
      (reference.sessionId === null || reference.sessionId === agent.id), "dsh ACP 会话身份或工作目录不匹配。");
    await agent.ctx.plugin({ name: "pbot-acp-expert", inject, apply: async scope => {
      registerDshSkills(scope, agent);
      dshExpertTools(scope, agent, member.d.options);
      await dshResources(scope, agent, member.d.workspace, "general-purpose", () => process.env.PBOT_ACP_PYTHON_STATE === "ready" && process.env.VIRTUAL_ENV
        ? { state: "ready", directory: process.env.VIRTUAL_ENV } : { state: process.env.PBOT_ACP_PYTHON_STATE ?? "unavailable" }, member.check);
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
