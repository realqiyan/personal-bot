import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HistorySummarizer } from "../../../model/history.js";
import { requireThat } from "../../../common/validation.js";
import { reduceHistorySummary } from "../../history-summary.js";

export async function historySummarizer(ctx: ExtensionContext): Promise<HistorySummarizer> {
  const model = ctx.model;
  requireThat(model, "请先选择 Pi 模型。");
  const budget = Math.max(2000, Math.min(24000, Math.floor(model.contextWindow / 2)));
  const ask: HistorySummarizer = async ({ system, prompt, maxTokens }, signal) => {
    signal.throwIfAborted();
    const response = await ctx.modelRegistry.streamSimple(model, { systemPrompt: system,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal, reasoning: "low", maxTokens, transport: "sse" }).result();
    signal.throwIfAborted();
    requireThat(response.stopReason === "stop", response.errorMessage ?? "历史摘要未完成：" + response.stopReason);
    const answer = response.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    requireThat(answer, "历史摘要为空。");
    return answer;
  };
  return reduceHistorySummary(budget, ask);
}
