import type { HistorySummarizer } from "../model/history.js";
import { requireThat } from "../common/validation.js";

export function reduceHistorySummary(budget: number, ask: HistorySummarizer): HistorySummarizer {
  return async (text, signal) => {
    while (text.length > budget) {
      const parts: string[] = [];
      for (let offset = 0; offset < text.length;) {
        signal.throwIfAborted();
        let end = Math.min(text.length, offset + budget);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        parts.push(await ask(text.slice(offset, end), signal)); offset = end;
      }
      const smaller = parts.join("\n\n");
      requireThat(smaller.length < text.length, "历史摘要未缩短，稍后重试。");
      text = smaller;
    }
    signal.throwIfAborted(); return ask(text, signal);
  };
}
