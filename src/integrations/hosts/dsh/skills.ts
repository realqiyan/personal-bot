import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-fs";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { scopeParentOf } from "@deepseek-ai/dsh-scope";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import { resourceRoot } from "../../../common/paths.js";

export interface DshSkillsOptions {
  /** Also register `<workspaceRoot>/.agents/skills` (useful when agent cwd is nested inside the workspace). */
  workspaceRoot?: string;
}

/** Keep bundled methods local to this Agent without overriding its native project/user methods. */
export function registerDshSkills(ctx: Context, agent: Agent, options: DshSkillsOptions = {}): void {
  const customSkillDirs = options.workspaceRoot ? [join(options.workspaceRoot, ".agents", "skills")] : undefined;
  let filesystem: FileSystemSkillProvider;
  ctx.skills.registerProvider(control => {
    filesystem = new FileSystemSkillProvider(ctx, control, {
      providerName: "pbot",
      includeDefaultRoots: false,
      bundledSkillDir: join(resourceRoot, "skills"),
      ...(customSkillDirs ? { customSkillDirs } : {}),
    });
    return {
      name: "pbot",
      async list(listOptions) {
        const inherited = await ctx.skills.snapshot({ ...listOptions, scope: scopeParentOf(agent) });
        const preferred = new Set(inherited.skills.filter(skill => skill.provider !== "pbot").map(skill => skill.name));
        const listed = await filesystem.list(listOptions);
        const candidates = Array.isArray(listed) ? listed : listed.candidates;
        return { candidates: candidates.filter(skill => !preferred.has(skill.name)),
          complete: inherited.complete && (Array.isArray(listed) || listed.complete) };
      },
      get: (candidate, getOptions) => filesystem.get(candidate, getOptions),
    };
  });
  ctx.effect(() => () => filesystem.dispose());
  ctx.on("fs/observed", target => { filesystem.observeHostMutation(target.displayPath); });
}
