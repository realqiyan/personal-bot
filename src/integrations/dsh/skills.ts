import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { scopeParentOf } from "@deepseek-ai/dsh-scope";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import { resourceRoot } from "../../common/paths.js";

/** Keep bundled methods local to this Agent without overriding its native project/user methods. */
export function registerDshSkills(ctx: Context, agent: Agent): void {
  let filesystem: FileSystemSkillProvider;
  ctx.skills.registerProvider(control => {
    filesystem = new FileSystemSkillProvider(ctx, control, {
      providerName: "pbot", includeDefaultRoots: false, bundledSkillDir: join(resourceRoot, "skills"),
    });
    return {
      name: "pbot",
      async list(options) {
        const inherited = await ctx.skills.snapshot({ ...options, scope: scopeParentOf(agent) });
        const preferred = new Set(inherited.skills.filter(skill => skill.provider !== "pbot").map(skill => skill.name));
        const listed = await filesystem.list(options);
        const candidates = Array.isArray(listed) ? listed : listed.candidates;
        return { candidates: candidates.filter(skill => !preferred.has(skill.name)),
          complete: inherited.complete && (Array.isArray(listed) || listed.complete) };
      },
      get: (candidate, options) => filesystem.get(candidate, options),
    };
  });
  ctx.effect(() => () => filesystem.dispose());
  ctx.on("fs/observed", target => { filesystem.observeHostMutation(target.displayPath); });
}
