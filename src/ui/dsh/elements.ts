import { object } from "../../common/json.js";

export const record = (value: unknown): Record<string, unknown> => { if (!object(value)) throw new Error("管理数据无效。"); return value; };
export const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
export const text = (value: unknown) => value === null || value === undefined ? "" : String(value);

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, content = "", className = "") {
  const node = document.createElement(tag); node.textContent = content; node.className = className; return node;
}
export function block(value: unknown) { return element("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2), "pbot-prose"); }
export function note(value: string) { return element("p", value, "pbot-muted"); }
export function group(parent: HTMLElement, className = "pbot-stack") {
  const node = element("div", "", className); parent.append(node); return node;
}
export function details(parent: HTMLElement, title: string) {
  const node = element("details", "", "pbot-disclosure"); node.append(element("summary", title)); parent.append(node); return node;
}
export function field(parent: HTMLElement, label: string) {
  const wrapper = element("label", "", "pbot-field"), input = element("input");
  wrapper.append(element("span", label)); input.setAttribute("aria-label", label);
  wrapper.append(input); parent.append(wrapper); return input;
}
export function select(parent: HTMLElement, label: string, values: [string, string][]) {
  const wrapper = element("label", "", "pbot-field"), input = element("select");
  wrapper.append(element("span", label)); input.setAttribute("aria-label", label);
  for (const [value, title] of values) { const option = element("option", title); option.value = value; input.append(option); }
  wrapper.append(input); parent.append(wrapper); return input;
}
export function facts(values: [string, unknown][]) {
  const node = element("dl", "", "pbot-facts");
  for (const [label, value] of values) node.append(element("dt", label), element("dd", text(value) || "—"));
  return node;
}
export function empty(title: string, description: string) {
  const node = element("div", "", "pbot-empty"); node.append(element("h3", title), note(description)); return node;
}
export function pageTitle(parent: HTMLElement, title: string) {
  const node = element("header", "", "pbot-page-title"); node.append(element("h2", title)); parent.append(node); return node;
}
export function time(value: unknown) {
  const date = new Date(typeof value === "number" ? value : text(value));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
