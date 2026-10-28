import type { Static } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamService } from "../../services/agents/team-service.js";
import type { AgentService } from "../../services/agents/agent-service.js";
import type { TeamActor } from "../../model/team.js";
import { agentOwner } from "../../integrations/pi/agent-context.js";
import { teamMessagesMarkdown } from "../../integrations/pi/team-context.js";
import { requireThat, schema } from "../../common/validation.js";
import type { CallAccess } from "../access.js";
import { markdownResult, result } from "../result.js";
import { teamParametersSchema, teamActionSchema, teamResultSchema, teamMessageParametersSchema, teamMessageActionSchema, teamMessageResultSchema } from "./contract.js";

export function teamTool(service: TeamService, agents: AgentService, access: Pick<CallAccess, "check">) {
  const valid = schema(teamActionSchema);
  return defineTool({ name: "pbot_team", label: "团队",
    description: "主会话管理固定成员团队。create 不启动模型；run 在空闲成员间运行有限 roundRobin 轮流讨论或 parallel 并行轮次，默认 2 轮、15 分钟。成员直接取得公共原文。团队运行时占用成员；pause 不杀死在途工作，收尾后可私人 send。close 不停止 agent。恢复不重跑旧请求；继续须明确 run 新批次。完成仍需业务验收。",
    parameters: teamParametersSchema, outputSchema: teamResultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      requireThat(valid(args), "团队参数不符合所选 action。");
      const input = args as Static<typeof teamParametersSchema>, owner = agentOwner(ctx), views = agents.list(owner);
      service.recover(owner);
      let id = input.teamId!;
      switch (input.action) {
        case "create": id = service.create(owner, { name: input.name!, brief: input.brief!, members: input.members! }, views).teamId; break;
        case "list": return markdownResult({ teams: service.list(owner, views) }, "团队列表");
        case "read": {
          const page = service.read(id, { kind: "coordinator", owner }, input);
          return result(page, false, teamMessagesMarkdown(page));
        }
        case "run": service.run(id, owner, { instruction: input.instruction!, mode: input.mode!,
          ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
          ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }) }, views); break;
        case "pause": service.pause(id, owner); break;
        case "close": service.close(id, owner, views); break;
      }
      return markdownResult(service.status(id, owner, views), "团队状态");
    },
  });
}
export function teamMessageTool(service: TeamService, access: Pick<CallAccess, "check">, actor: (ctx: ExtensionContext) => TeamActor) {
  const valid = schema(teamMessageActionSchema);
  return defineTool({ name: "pbot_team_message", label: "团队消息",
    description: "直接读取/发布团队公共原文。post 不唤醒模型、不增加轮次，所有成员可见，不提供私信或递归委派。成员只能在自己的团队工作中 post。read 用 afterSeq 分页；长消息用 seq/offset/limit 继续，nextOffset 非空表示该条正文不完整。保存成功不是模型已读或业务完成。",
    parameters: teamMessageParametersSchema, outputSchema: teamMessageResultSchema,
    async execute(id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted(); requireThat(valid(args), "团队消息参数无效。");
      const input = args as Static<typeof teamMessageParametersSchema>, sender = actor(ctx);
      if (input.action === "read") {
        const page = service.read(input.teamId, sender, input);
        return result(page, false, teamMessagesMarkdown(page));
      }
      const message = service.post(input.teamId, sender, id, input.text!, input.replyTo);
      return markdownResult({ teamId: input.teamId, seq: message.seq, status: "stored" }, "团队消息已保存");
    },
  });
}
