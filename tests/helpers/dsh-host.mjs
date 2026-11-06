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

/** Real Cordis, loop and disk backend; no provider or credentials are installed. */
export async function dshHost(directory) {
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
    const owner = await ctx.plugin({
      name: "pbot-test-owner",
      inject: ["agents", "sessions", "sessionPersistence", "sessionQuery", "commands", "tools", "systemPrompt", "llm", "sessionProjections", "fs", "skills", "workingDirectory", "attachments", "approval", "typert"],
      async apply(scope) { await scope.plugin(AgentLoop, { agents: [] }); },
    });
    return { ctx: owner.ctx, async close() { await owner.dispose(); await ctx.fiber.dispose(); } };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
