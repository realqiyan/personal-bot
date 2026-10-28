import { json } from "../common/json.js";
import { markdownFields } from "../common/markdown.js";

export function markdownResult(value: unknown, title: string) {
  return result(value, false, "# " + title + "\n\n" + markdownFields(json(value)));
}

export function result(value: unknown, isError = false, text?: string) {
  const data = json(value);
  return { content: [{ type: "text" as const, text: text ?? JSON.stringify(data) }],
    details: data, structuredContent: data, ...(isError ? { isError: true } : {}) };
}
