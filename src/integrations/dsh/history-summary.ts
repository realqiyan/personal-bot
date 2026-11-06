import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { BlockAssembler, type PreparedLlmCall } from "@deepseek-ai/dsh-llm";
import type { HistorySummarizer } from "../../model/history.js";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";
import { reduceHistorySummary } from "../history-summary.js";

declare module "@deepseek-ai/dsh-llm" {
  interface LlmRequestPurposeMap { "pbot-history": true }
}

/** Independent text calls through the host's routing and authentication; no Agent or Session messages. */
export function dshHistorySummarizer(ctx: Context, selection: ReturnType<Agent["model"]["current"]>, sessionId: SessionId): HistorySummarizer {
  return async (text, signal) => {
    requireThat(selection, "请先选择 dsh 模型。"); signal.throwIfAborted();
    const system = await readFile(join(resourceRoot, "prompts/history-summary.md"), { encoding: "utf8", signal });
    const prepare = () => ctx.llm.prepareCall({ provider: selection.provider, model: selection.model, maxTokens: 2048 }, signal,
      (controls, model) => ({ ...controls, ...(model.reasoning?.efforts[0] ? { reasoningEffort: model.reasoning.efforts[0].id } : {}) }));
    let first: PreparedLlmCall | undefined = await prepare();
    const budget = Math.max(2000, Math.min(24000, Math.floor((first.context?.contextWindow ?? 12000) / 2)));
    const ask: HistorySummarizer = async (content, signal) => {
      signal.throwIfAborted();
      const prepared = first ?? await prepare(); first = undefined;
      const assembler = new BlockAssembler(); let finished = false;
      for await (const chunk of prepared.stream({ ...prepared.config, system, sessionId, purpose: "pbot-history", signal, tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: content }] }] })) {
        signal.throwIfAborted(); assembler.push(chunk); if (chunk.type === "finish") finished = true;
      }
      signal.throwIfAborted();
      const reason = assembler.finish;
      requireThat(finished && reason.kind === "stop", reason.kind === "error" || reason.kind === "aborted" ? reason.failure.message : "历史摘要未正常结束：" + reason.kind);
      const blocks = assembler.blocks();
      requireThat(!blocks.some(block => block.type === "tool-call"), "历史摘要不能执行工具。");
      const answer = blocks.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      requireThat(answer, "历史摘要为空。"); return answer;
    };
    return reduceHistorySummary(budget, ask)(text, signal);
  };
}
