import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-working-directory";
import type {} from "@deepseek-ai/dsh-tools";
import { agentText } from "../agent-resources.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { isMcpWorkerTool } from "../../model/acp.js";
import type { AgentOptions } from "../../model/agent.js";

export async function dshResources(
  ctx: Context,
  _agent: Agent,
  root: string,
  role: "coordinator" | "general-purpose",
  check: () => void,
  coordinatorPrompt = "history-coordinator.md",
) {
  const read = () => Promise.all([agentText(role, root, coordinatorPrompt), readFile(join(resourceRoot, "prompts/workspace.md"), "utf8")]);
  const [text, workspace] = await read();
  check();
  ctx.systemPrompt.section({ name: "pbot:role", order: 1, text, interpolate: false });
  ctx.systemPrompt.section({ name: "pbot:workspace", order: 2, text: workspace, interpolate: false });
  ctx.systemPrompt.context({
    name: "pbot:environment", order: 300, required: true, interpolate: false,
    text: JSON.stringify({ host: "dsh", workspaceRoot: root, resourceRoot }),
  });
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    check();
    const [roleText, workspaceText] = await read();
    check();
    const assembly = await next();
    return {
      ...assembly,
      sections: assembly.sections.map(section => section.name === "pbot:role" ? { ...section, text: roleText }
        : section.name === "pbot:workspace" ? { ...section, text: workspaceText } : section),
    };
  });
}

/** Map an ACP dsh worker's native loadout without interfering with coordinator sessions. */
export function dshExpertTools(ctx: Context, agent: Agent, options: AgentOptions) {
  const names = new Set(ctx.tools.definitions(agent).map(tool => tool.name));
  const forbidden = new Set([
    "pbot_history",
    "subagent", "subagent_fork", "list_subagent_models", "list_agents", "send_message", "interrupt_agent",
  ]);
  if (options.noSkills) forbidden.add("skill");
  const isForbidden = (name: string) => forbidden.has(name) || isMcpWorkerTool(name);
  if (options.tools) {
    for (const name of options.tools) requireThat(names.has(name) && !isForbidden(name), "专家工具不可用：" + name);
    ctx.tools.restrict({ allow: options.tools });
  }
  const deny = [...names].filter(isForbidden);
  if (deny.length) ctx.tools.restrict({ deny });
}
