import type { Static } from "typebox";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { AgentOptions, AgentOwner, AgentView } from "../../model/agent.js";
import { markdownResult } from "../result.js";
import type { agentParametersSchema, agentViewSchema } from "./contract.js";

export type AgentInput = Omit<Static<typeof agentParametersSchema>, "thinking"> & { thinking?: string };
type AgentOutput = Static<typeof agentViewSchema>;
function agentOutput(view: AgentView & Partial<AgentOutput>): AgentOutput {
  const c = view.cycle;
  return {
    agentId: view.agentId, name: view.name, cwd: view.cwd, createdAt: view.createdAt,
    owned: view.owned, state: view.state, activity: view.activity,
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


export async function executeAgent(service: AgentService, input: AgentInput, owner: AgentOwner, defaults: AgentOptions = {}) {
  let value: AgentView & Partial<AgentOutput>;
  switch (input.action) {
    case "start": {
      const { action: _action, ...supplied } = input;
      value = await service.start({ ...defaults, ...supplied } as AgentOptions, owner); break;
    }
    case "list": return markdownResult({ agents: service.list(owner).map(agentOutput) }, "子会话列表");
    case "send": value = service.send(input.agentId!, input.message!, input.delivery ?? "steer", owner); break;
    case "rename": value = service.rename(input.agentId!, input.name!, owner); break;
    case "resume": value = await service.resume(input.agentId!, input.message!, owner); break;
    case "stop": value = service.stop(input.agentId!, owner); break;
    case "status": value = service.status(input.agentId!, owner); break;
    case "read": {
      const page = await service.read(input.agentId!, owner, input.cycleId, input.offset, input.limit);
      const data = agentOutput(page), output = markdownResult(data, "子会话报告");
      return { ...output, details: { ...data, ...(page.cycle && page.cycle.state !== "running" ? { agentReadKeys: [page.agentId + ":" + page.cycle.cycleId] } : {}) } };
    }
  }
  return markdownResult(agentOutput(value), "子会话状态");
}
