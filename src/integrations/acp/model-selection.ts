import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpBackend, AcpChoice, AcpModelSelection } from "../../model/acp.js";
import { requireThat } from "../../common/validation.js";
import { resolveAcpHarness } from "./registry.js";

type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

function optionFor(options: SessionConfigOption[], category: "model" | "thought_level"): SelectOption | undefined {
  const ids = category === "model" ? ["model"] : ["thought_level", "thinking", "reasoning_effort", "effort"];
  return options.find((option): option is SelectOption => option.type === "select" && ids.includes(option.id)) ??
    options.find((option): option is SelectOption => option.type === "select" && option.category === category);
}
function values(option: SelectOption) {
  return [...new Map(option.options.flatMap(item => "options" in item ? item.options : [item]).map(item => [item.value, item])).values()];
}
function modelIdentity(backend: AcpBackend, value: string): { provider?: string; model: string } {
  const harness = resolveAcpHarness(backend);
  return harness.parseModelValue ? harness.parseModelValue(value) : { model: value };
}
/** Case, spacing and punctuation-insensitive form so "Opus 4.5" meets "claude-opus-4-5". */
const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const listing = (items: { value: string; name?: string }[]) =>
  items.map(item => item.name && item.name !== item.value ? `${item.value}（${item.name}）` : item.value).join(", ");

/** Resolve a native model ID against the peer's advertised values using the harness adapter. */
export function acpModelValue(backend: AcpBackend, options: SessionConfigOption[], model: string, provider?: string) {
  const option = optionFor(options, "model");
  requireThat(option, "ACP 后端未提供可选择的模型。");
  const choices = values(option);
  const harness = resolveAcpHarness(backend);
  const formatted = harness.formatModelQuery?.(model, provider);
  if (formatted) {
    const qualified = choices.find(item => item.value === formatted);
    if (qualified) return { configId: option.id, value: qualified.value };
  }
  const entries = choices.map(item => ({ ...modelIdentity(backend, item.value), value: item.value, name: item.name }));
  const matchEntries = (pool: typeof entries, target: string) => {
    let matched = pool.filter(item => item.value === target || item.model === target);
    const exact = matched.filter(item => item.value === target);
    if (exact.length) matched = exact;
    if (!matched.length) {
      // Users name models loosely; accept a unique case-insensitive or partial match on the value, model ID or display name.
      const query = compact(target);
      if (query) {
        const keys = (item: typeof pool[number]) => [item.value, item.model, item.name].map(compact);
        matched = pool.filter(item => keys(item).includes(query));
        if (!matched.length && query.length >= 2) matched = pool.filter(item => keys(item).some(key => key.includes(query)));
      }
    }
    return matched;
  };
  const filterByProvider = (targetProvider: string) => {
    const exactProvider = entries.filter(item => item.provider === targetProvider);
    if (exactProvider.length) return exactProvider;
    const providerQuery = compact(targetProvider);
    return providerQuery ? entries.filter(item => item.provider && compact(item.provider) === providerQuery) : [];
  };
  const available = provider ? filterByProvider(provider) : entries;
  let matches = matchEntries(available, model);
  if (!matches.length && !provider && model.includes("/")) {
    // Support "provider/model" syntax for multi-provider harnesses without requiring a separate provider parameter.
    for (let index = model.indexOf("/"); index > 0; index = model.indexOf("/", index + 1)) {
      const candidateProvider = model.slice(0, index);
      const candidateModel = model.slice(index + 1);
      if (!candidateModel) continue;
      const scoped = filterByProvider(candidateProvider);
      if (!scoped.length) continue;
      const scopedMatches = matchEntries(scoped, candidateModel);
      if (scopedMatches.length) { matches = scopedMatches; break; }
    }
  }
  if (matches.length > 1 && !provider) {
    const current = modelIdentity(backend, option.currentValue);
    const sameProvider = matches.filter(item => item.provider === current.provider);
    if (sameProvider.length === 1) matches = sameProvider;
  }
  const all = choices.map(item => ({ value: item.value, name: item.name }));
  requireThat(matches.length, "ACP 模型不可用：" + [provider, model].filter(Boolean).join("/") + "；可用值：" + listing(all));
  requireThat(matches.length === 1, "多个模型与该名称匹配，请指定完整模型值（或 provider/model）：" + listing(matches));
  return { configId: option.id, value: matches[0]!.value };
}
export function acpThinkingValue(options: SessionConfigOption[], thinking: string) {
  const option = optionFor(options, "thought_level");
  requireThat(option, "目标模型未提供可选择的思考等级。");
  const available = values(option);
  const query = compact(thinking);
  const chosen = available.find(item => item.value === thinking) ??
    (query ? (([match, ...rest]) => match && !rest.length ? match : undefined)(available.filter(item => compact(item.value) === query || compact(item.name) === query)) : undefined);
  requireThat(chosen, "ACP 思考等级不可用：" + thinking + "；可用值：" + listing(available));
  return { configId: option.id, value: chosen.value };
}
export function acpModelSelection(backend: AcpBackend, options: SessionConfigOption[], effectiveThinking?: string): AcpModelSelection {
  const model = optionFor(options, "model"), thinking = optionFor(options, "thought_level");
  const selectedThinking = effectiveThinking === "unset" ? effectiveThinking
    : thinking && effectiveThinking && values(thinking).some(item => item.value === effectiveThinking) ? effectiveThinking : thinking?.currentValue;
  return { ...(model ? modelIdentity(backend, model.currentValue) : {}), ...(selectedThinking ? { thinking: selectedThinking } : {}) };
}
/** Advertised model and thinking choices, for callers that must pick valid values. */
export function acpChoices(options: SessionConfigOption[]) {
  const choice = (item: { value: string; name: string; description?: string | null }): AcpChoice =>
    ({ value: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) });
  const model = optionFor(options, "model"), thinking = optionFor(options, "thought_level");
  return {
    models: model ? values(model).map(choice) : [],
    thinking: thinking ? values(thinking).map(choice) : [],
    ...(model ? { currentModel: model.currentValue } : {}),
    ...(thinking ? { currentThinking: thinking.currentValue } : {}),
  };
}
