import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentView } from "../model/agent.js";
import { duration, oneLine, stateLabel } from "./presentation.js";
export const agentSummary = (v: AgentView) => `${v.name} · ${stateLabel(v.state)} · ${v.agentId.slice(0, 8)}`;
export function agentBoard(values: AgentView[], theme: Theme): Component {
  return { invalidate() {}, render(width) {
    const active = values.filter(v => ["starting", "busy", "stopping"].includes(v.state));
    return [...active.slice(0, 4).map(v => truncateToWidth(
      theme.fg("accent", v.name) + theme.fg("dim", ` · ${stateLabel(v.state)} · ${duration(Date.now() - (v.cycle?.startedAt ?? v.createdAt))} · `) +
      oneLine(v.activity), Math.max(1, width))),
      ...(active.length > 4 ? [truncateToWidth(theme.fg("dim", `另有 ${active.length - 4} 位专家 · /pbot agents`), Math.max(1, width))] : [])];
  } };
}
