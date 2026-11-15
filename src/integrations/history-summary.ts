import type { HistorySummarizer } from "../model/history.js";

/** Split Pi/dsh summary inputs within the model's character budget. */
export function splitHistorySummary(text: string, budget: number): string[] {
  if (!Number.isInteger(budget) || budget < 2) throw new Error("历史摘要分段预算无效。");
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + budget);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(offset, end)); offset = end;
  }
  return parts;
}

export function reduceHistorySummary(budget: number, ask: HistorySummarizer): HistorySummarizer {
  return async (request, signal) => {
    let text = request.prompt;
    while (text.length > budget) {
      const parts: string[] = [];
      for (const prompt of splitHistorySummary(text, budget)) {
        signal.throwIfAborted();
        parts.push(await ask({ ...request, prompt }, signal));
      }
      const smaller = parts.join("\n\n");
      if (smaller.length >= text.length) throw new Error("历史摘要未缩短，稍后重试。");
      text = smaller;
    }
    signal.throwIfAborted(); return ask({ ...request, prompt: text }, signal);
  };
}
