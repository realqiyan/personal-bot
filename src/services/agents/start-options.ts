import type { AcpBackend } from "../../model/acp.js";
import type { AgentOptions, NativeAgentHost } from "../../model/agent.js";

const piOnly = ["noExtensions", "noPromptTemplates", "noContextFiles"] as const;

/** Keep only options the effective target can use; declared-but-inapplicable fields are inert. */
export function applicableStartOptions(kind: NativeAgentHost, backend: AcpBackend | undefined, options: AgentOptions): AgentOptions {
  const result = { ...options };
  if (backend) {
    if (backend !== "pi") {
      for (const key of piOnly) delete result[key];
      delete result.noSkills; delete result.tools;
    }
    if (backend === "claude") delete result.provider;
  } else if (kind !== "pi") {
    for (const key of piOnly) delete result[key];
  }
  return result;
}
