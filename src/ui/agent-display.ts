import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentView } from "../model/agent.js";
export const agentSummary = (v: AgentView) => `${v.name} · ${v.agentId.slice(0, 8)} · ${v.state} · ${v.activity.replace(/\s+/g, " ")}`;
export function agentBoard(values: AgentView[], theme: Theme): Component {
  return { invalidate() {}, render(width) {
    return values.filter(v => ["starting", "busy", "stopping"].includes(v.state)).map(v => truncateToWidth(
      theme.fg("accent", "● " + v.name) + theme.fg("dim", ` · ${v.state} · ${Math.max(0, Math.floor((Date.now() - (v.cycle?.startedAt ?? v.createdAt)) / 1000))}s · `) +
      v.activity.replace(/\s+/g, " "), Math.max(1, width)));
  } };
}
