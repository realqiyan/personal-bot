import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import * as SkillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import { resourceRoot } from "./common/paths.js";
import { registerDshCommand } from "./extension/dsh/command.js";
import { registerDshManagement } from "./extension/dsh/management.js";
import { DshWorkspaces, dshDependencies } from "./extension/dsh/workspace.js";
import { requireThat } from "./common/validation.js";

export const name = "personal-bot";
export const inject = ["commands", "typert", ...dshDependencies];

export async function apply(ctx: Context) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  requireThat(major! > 24 || (major === 24 && minor! >= 9), "dsh 接入需要 Node.js 24.9.0 或更新版本。");
  await ctx.plugin(SkillFilesystem, { providerName: "pbot", includeDefaultRoots: false, bundledSkillDir: join(resourceRoot, "skills") });
  const workspaces = new DshWorkspaces(ctx);
  ctx.effect(() => () => workspaces.close());
  const management = registerDshManagement(ctx, workspaces);
  registerDshCommand(ctx, workspaces, management);
  ctx.on("agent/created", async ({ agent }) => {
    if (ctx.agents.roots().includes(agent) && agent.session.header.origin !== "subagent") await workspaces.open(agent);
  });
  for (const agent of ctx.agents.roots()) if (agent.session.header.origin !== "subagent") await workspaces.open(agent);
  void workspaces.preparePython().catch(error => ctx.logger.warn(String(error)));
}
