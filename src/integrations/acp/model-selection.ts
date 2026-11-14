import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpBackend, AcpModelSelection } from "../../model/acp.js";
import { requireThat } from "../../common/validation.js";

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
  if (backend === "dsh") {
    try {
      const parts: unknown = JSON.parse(value);
      if (Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === "string" && part.length > 0)) {
        return { provider: parts[0], model: parts[1] };
      }
    } catch { /* Unencoded identifiers remain usable as exact ACP option values. */ }
  }
  if (backend === "pi") {
    const separator = value.indexOf("/");
    if (separator > 0) return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
  }
  return { model: value };
}

/** Resolve a native model ID against the peer's advertised values. */
export function acpModelValue(backend: AcpBackend, options: SessionConfigOption[], model: string, provider?: string) {
  const option = optionFor(options, "model");
  requireThat(option, "ACP 后端未提供可选择的模型。");
  const choices = values(option);
  if (backend === "pi" && provider) {
    const qualified = choices.find(item => item.value === provider + "/" + model);
    if (qualified) return { configId: option.id, value: qualified.value };
  }
  const available = choices.map(item => ({ ...modelIdentity(backend, item.value), value: item.value }));
  let matches = available.filter(item => (item.value === model || item.model === model) && (!provider || item.provider === provider));
  const exact = matches.filter(item => item.value === model);
  if (exact.length) matches = exact;
  if (matches.length > 1 && !provider) {
    const current = modelIdentity(backend, option.currentValue);
    const sameProvider = matches.filter(item => item.provider === current.provider);
    if (sameProvider.length === 1) matches = sameProvider;
  }
  requireThat(matches.length, "ACP 模型不可用：" + [provider, model].filter(Boolean).join("/") + "；可用值：" + available.map(item => item.value).join(", "));
  requireThat(matches.length === 1, "多个 ACP 提供方包含该模型，请指定 provider 或完整模型值：" + matches.map(item => item.value).join(", "));
  return { configId: option.id, value: matches[0]!.value };
}
export function acpThinkingValue(options: SessionConfigOption[], thinking: string) {
  const option = optionFor(options, "thought_level");
  requireThat(option, "目标模型未提供可选择的思考等级。");
  const available = values(option);
  const chosen = available.find(item => item.value === thinking);
  requireThat(chosen, "ACP 思考等级不可用：" + thinking + "；可用值：" + available.map(item => item.value).join(", "));
  return { configId: option.id, value: chosen.value };
}
export function acpModelSelection(backend: AcpBackend, options: SessionConfigOption[], effectiveThinking?: string): AcpModelSelection {
  const model = optionFor(options, "model"), thinking = optionFor(options, "thought_level");
  const selectedThinking = effectiveThinking === "unset" ? effectiveThinking
    : thinking && effectiveThinking && values(thinking).some(item => item.value === effectiveThinking) ? effectiveThinking : thinking?.currentValue;
  return { ...(model ? modelIdentity(backend, model.currentValue) : {}), ...(selectedThinking ? { thinking: selectedThinking } : {}) };
}
