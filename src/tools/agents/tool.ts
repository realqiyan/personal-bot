import type { Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../services/agents/agent-service.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import type { AgentOptions, AgentView } from "../../model/agent.js";
import type { CallAccess } from "../access.js";
import { requireThat, schema } from "../../common/validation.js";
import { result } from "../result.js";
import { agentActionSchema, agentParametersSchema, agentResultSchema, agentViewSchema } from "./contract.js";

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

export function agentTool(service: AgentService, access: CallAccess) {
  const valid = schema(agentActionSchema);
  return defineTool({ name: "pbot_agent", label: "子会话",
    description: "独立 Pi 子会话，不继承父聊天历史。start 立即返回，完成自动通知，无需轮询。send 继续对话，rename 改名，status/list 查看状态，read 非阻塞读取报告。state 是进程状态，cycle.state 是工作结果，queued 仅表示入队。stop 停止并保留历史，resume 携新 message 恢复，不重放旧工作。独立复核须 start 新上下文。子会话使用原生 CLI/MCP，按委派范围工作，不递归委派。每个父会话最多 50 个存活子会话，空闲也计入。",
    parameters: agentParametersSchema, outputSchema: agentResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      requireThat(valid(args), "子会话参数不符合所选 action；请核对必要字段。");
      const input = args as Static<typeof agentParametersSchema>, owner = agentOwner(ctx);
      let value: AgentView & Partial<AgentOutput>;
      switch (input.action) {
        case "start": {
          requireThat(input.message || input.prompts?.length || input.files?.length, "start 需要 message、prompts 或 files。");
          const { action: _action, ...supplied } = input;
          value = service.start({ provider: ctx.model?.provider, model: ctx.model?.id, thinking: ctx.thinkingLevel, ...supplied } as AgentOptions, owner); break;
        }
        case "list": return result({ agents: service.list(owner).map(agentOutput) });
        case "send": value = service.send(input.agentId!, input.message!, input.delivery ?? "steer", owner); break;
        case "rename": value = service.rename(input.agentId!, input.name!, owner); break;
        case "resume": value = service.resume(input.agentId!, input.message!, owner); break;
        case "stop": value = service.stop(input.agentId!, owner); break;
        case "status": value = service.read(input.agentId!, owner, undefined, 0, 1); break;
        case "read": {
          const page = service.read(input.agentId!, owner, input.cycleId, input.offset, input.limit);
          const data = agentOutput(page), output = result(data);
          return { ...output, details: { ...data, ...(page.cycle && page.cycle.state !== "running" ? { agentReadKeys: [page.agentId + ":" + page.cycle.cycleId] } : {}) } };
        }
      }
      return result(agentOutput(value));
    },
  });
}
