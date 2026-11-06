import { Context } from "@deepseek-ai/cordis";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import * as Executor from "@deepseek-ai/dsh-tool-executor-native";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import * as Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Query from "@deepseek-ai/dsh-session-query-sqlite";
import Commands from "@deepseek-ai/dsh-commands";
import Fs from "@deepseek-ai/dsh-fs-local";
import Skills from "@deepseek-ai/dsh-skill";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import Attachments from "@deepseek-ai/dsh-attachment-local";
import Approval from "@deepseek-ai/dsh-user-approval";
import Typert from "@deepseek-ai/dsh-typert-registry";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Presets from "@deepseek-ai/dsh-agent-preset-registry";
import Preset from "@deepseek-ai/dsh-agent-preset";
import Subagents from "@deepseek-ai/dsh-subagent";
import * as Fork from "@deepseek-ai/dsh-subagent-fork-in-process";

/** Real Cordis, loop and disk backend; no LLM adapter or credentials are installed. */
export async function dshHost(directory, { presets = false } = {}) {
  const ctx = new Context();
  try {
    for (const plugin of [Typert, SessionProjection, SystemPrompt, Tools, Llm, Sessions, Agents, Commands]) await ctx.plugin(plugin);
    await ctx.plugin(Executor);
    await ctx.plugin(Fs, { cwd: directory });
    await ctx.plugin(Skills);
    await ctx.plugin(WorkingDirectory, { defaultDirectory: directory });
    await ctx.plugin(Approval, { policy: "never" });
    await ctx.plugin(Attachments, { dshHome: directory });
    await ctx.plugin(Persistence, { root: directory });
    await ctx.plugin(Query, { path: ":memory:", openAt: "never" });
    if (presets) {
      await ctx.plugin(Loader, { baseUrl: new URL("../../package.json", import.meta.url).href });
      await ctx.plugin(Presets, { default: "pbot-test-standard" });
      await ctx.plugin(Subagents);
      await ctx.plugin(Fork);
    }
    const owner = await ctx.plugin({
      name: "pbot-test-owner",
      inject: ["agents", "sessions", "sessionPersistence", "sessionQuery", "commands", "tools", "systemPrompt", "llm", "sessionProjections", "fs", "skills", "workingDirectory", "attachments", "approval", "typert", ...(presets ? ["agentPresets"] : [])],
      async apply(scope) {
        await scope.plugin(AgentLoop, { agents: [] });
        if (presets) await scope.plugin(Preset, { id: "pbot-test-standard", plugins: [
          { id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix: "Native preset fixture {{model}}" } },
          { id: "instructions", name: "@deepseek-ai/dsh-agent-instructions", config: { maxBytes: 65536 } },
          { id: "files", name: "@deepseek-ai/dsh-tool-fs", config: { applyPatch: true } },
          { id: "skills", name: "@deepseek-ai/dsh-skill-filesystem" },
          { id: "skill-tool", name: "@deepseek-ai/dsh-tool-skill" },
          { id: "fork-tool", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "fork", toolName: "subagent_fork" } },
        ] });
      },
    });
    return { ctx: owner.ctx, async close() { await owner.dispose(); await ctx.fiber.dispose(); } };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
