import type { Json } from "./json.js";

/** Preserve original text, including embedded Markdown fences. */
export function markdownBlock(text: string): string {
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = "`".repeat(fenceLength);
  return fence + "text\n" + text + "\n" + fence;
}

/** Render structured result fields without changing their machine-readable values. */
export function markdownFields(value: Json, level = 2): string {
  if (value === null || typeof value !== "object") return typeof value === "string" ? markdownBlock(value) : String(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) =>
    "#".repeat(level) + " " + (index + 1) + "\n\n" + markdownFields(item, level + 1)).join("\n\n") : "（空）";
  const fields: string[] = [], sections: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if ((item !== null && typeof item === "object") || (typeof item === "string" && (item.includes("\n") || key === "report" || key === "text"))) {
      sections.push("#".repeat(level) + " " + key + "\n\n" + markdownFields(item, level + 1));
    } else {
      const text = String(item).replace(/[\\`*_{}\[\]<>#!|]/g, "\\$&");
      fields.push("- " + key + ": " + text);
    }
  }
  return [fields.join("\n"), ...sections].filter(Boolean).join("\n\n");
}
