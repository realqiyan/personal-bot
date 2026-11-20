import type { Agent, AgentRegistry } from "@deepseek-ai/dsh-agent";

export function rootAgents(registry: Pick<AgentRegistry, "list"> & { roots?: () => Agent[] }): Agent[] {
  return (registry.roots?.() ?? registry.list()).filter(agent => agent.session.header.origin !== "subagent");
}
