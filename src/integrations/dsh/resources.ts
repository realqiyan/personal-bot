import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import type {} from "@deepseek-ai/dsh-working-directory";
import type {} from "@deepseek-ai/dsh-tools";
import { agentText } from "../agent-resources.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import type { AgentOptions } from "../../model/agent.js";

export async function dshResources(ctx: Context, agent: Agent, root: string,
  role: "coordinator" | "general-purpose", python: () => { state: string; directory?: string; error?: string }, check: () => void) {
  let text = await agentText(role, root);
  const workspace = await readFile(join(resourceRoot, "prompts/workspace.md"), "utf8");
  check();
  ctx.systemPrompt.section({ name: "pbot:role", order: 1, text: () => text, interpolate: false });
  ctx.systemPrompt.section({ name: "pbot:workspace", order: 2, text: workspace, interpolate: false });
  ctx.systemPrompt.context({ name: "pbot:environment", order: 300, required: true, interpolate: false,
    text: () => JSON.stringify({ host: "dsh", workspaceRoot: root, cwd: ctx.workingDirectory.get(agent.session), resourceRoot, python: python() }) });
  ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
    providerName: "pbot", includeDefaultRoots: false, customSkillDirs: [join(root, ".agents/skills")],
    bundledSkillDir: join(resourceRoot, "skills"), watch: false,
  }));
  ctx.on("agent/pre-step", async (_payload, next) => {
    check(); text = await agentText(role, root); check();
    return next();
  });
}

/** Map the expert's native loadout; this is not isolation from Bash, CLI, or MCP. */
export function dshExpertTools(ctx: Context, agent: Agent, options: AgentOptions) {
  const names = new Set(ctx.tools.definitions(agent).map(tool => tool.name));
  const forbidden = new Set(["pbot_agent", "pbot_team", "pbot_history", "subagent", "list_subagent_models", "list_agents", "send_message", "interrupt_agent"]);
  if (options.noSkills) forbidden.add("skill");
  if (options.tools) {
    for (const name of options.tools) requireThat((names.has(name) || name === "pbot_team_message") && !forbidden.has(name), "专家工具不可用：" + name);
    ctx.tools.restrict({ allow: options.tools.filter(name => name !== "pbot_team_message") });
  }
  const deny = [...forbidden].filter(name => names.has(name));
  if (deny.length) ctx.tools.restrict({ deny });
  return !options.tools || options.tools.includes("pbot_team_message");
}
