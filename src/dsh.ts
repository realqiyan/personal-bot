import type { Context } from "@deepseek-ai/cordis";
import { registerDshCommand } from "./extension/hosts/dsh/command.js";
import { registerDshManagement } from "./extension/hosts/dsh/management.js";
import { DshWorkspaces, dshDependencies } from "./extension/hosts/dsh/workspace.js";
import { requireThat } from "./common/validation.js";
import { rootAgents } from "./integrations/hosts/dsh/root-agents.js";

export const name = "personal-bot";
export const inject = ["commands", "typert", ...dshDependencies];

export async function apply(ctx: Context) {
  if (process.env.PBOT_SUBAGENT_RUN_ID) return;
  const [major, minor] = process.versions.node.split(".").map(Number);
  requireThat(major! > 24 || (major === 24 && minor! >= 9), "dsh 接入需要 Node.js 24.9.0 或更新版本。");
  const workspaces = new DshWorkspaces(ctx);
  ctx.effect(() => () => workspaces.close());
  const management = registerDshManagement(ctx, workspaces);
  registerDshCommand(ctx, workspaces, management);
  ctx.on("agent/created", async ({ agent }) => {
    if (rootAgents(ctx.agents).includes(agent)) await workspaces.open(agent);
  });
  for (const agent of rootAgents(ctx.agents)) await workspaces.open(agent);
}
