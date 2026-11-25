import type { Static } from "typebox";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOptions, AgentOwner, AgentView } from "../../model/agent.js";
import { markdownResult } from "../result.js";
import type { AgentInput, agentViewSchema } from "./contract.js";

type AgentOutput = Static<typeof agentViewSchema>;
function agentOutput(view: AgentView & Partial<AgentOutput>): AgentOutput {
  const c = view.cycle;
  return {
    agentId: view.agentId, name: view.name, cwd: view.cwd, createdAt: view.createdAt,
    owned: view.owned, state: view.state, activity: view.activity,
    ...(view.backend ? { backend: view.backend, transport: view.transport, capabilities: view.capabilities } : {}),
    ...(view.selection ? { selection: view.selection } : {}),
    ...(c ? { cycle: { cycleId: c.cycleId, startedAt: c.startedAt, state: c.state, requestIds: c.requestIds, source: c.source,
      ...(c.finishedAt === undefined ? {} : { finishedAt: c.finishedAt }), ...(c.error === undefined ? {} : { error: c.error }) } } : {}),
    ...(view.error === undefined ? {} : { error: view.error }),
    ...(view.requestId === undefined ? {} : { requestId: view.requestId }),
    ...(view.messageStatus === undefined ? {} : { messageStatus: view.messageStatus }),
    ...(view.cycles === undefined ? {} : { cycles: view.cycles }),
    ...(view.report === undefined ? {} : { report: view.report }),
    ...(view.totalLength === undefined ? {} : { totalLength: view.totalLength }),
    ...(view.nextOffset === undefined ? {} : { nextOffset: view.nextOffset }),
  };
}

/** Parent selection is inherited only for a native expert; a chosen model drops the thinking default. */
function inherited(input: AgentInput, defaults: AgentOptions) {
  if (input.action !== "start" || input.backend) return {};
  const changed = Boolean(input.provider && defaults.provider && input.provider !== defaults.provider) ||
    Boolean(input.model && defaults.model && input.model !== defaults.model);
  const options = { ...defaults };
  if (changed) delete options.thinking;
  return options;
}

export async function executeAgent(service: AgentService, input: AgentInput, owner: AgentOwner, defaults: AgentOptions = {}) {
  let value: AgentView & Partial<AgentOutput>;
  switch (input.action) {
    case "start": {
      const { action: _action, ...supplied } = input;
      value = await service.start({ ...inherited(input, defaults), ...supplied }, owner); break;
    }
    case "list": return markdownResult({ agents: service.list(owner).map(agentOutput) }, "专家列表");
    case "send": value = service.send(input.agentId, input.message, input.delivery ?? "steer", owner); break;
    case "rename": value = service.rename(input.agentId, input.name, owner); break;
    case "resume": value = await service.resume(input.agentId, input.message, owner); break;
    case "stop": value = service.stop(input.agentId, owner); break;
    case "status": value = service.status(input.agentId, owner); break;
    case "read": {
      const page = await service.read(input.agentId, owner, input.cycleId, input.offset, input.limit);
      const data = agentOutput(page), output = markdownResult(data, "专家报告");
      return { ...output, details: { ...data, ...(page.cycle && page.cycle.state !== "running" ? { agentReadKeys: [page.agentId + ":" + page.cycle.cycleId] } : {}) } };
    }
  }
  return markdownResult(agentOutput(value), "专家状态");
}
