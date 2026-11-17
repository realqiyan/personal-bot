import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { Type, type Static } from "typebox";
import { object, json } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { executeAgent } from "../../tools/agents/actions.js";
import { agentInput } from "../../tools/agents/contract.js";
import { executeTeam, executeTeamMessage } from "../../tools/teams/actions.js";
import { teamInput, teamMessageInput } from "../../tools/teams/contract.js";
import { dshWorkspaceStatus, type PbotManagement } from "./management.js";
import type { DshWorkspaces } from "./workspace.js";

const chatSchema = Type.Object({ agentId: Type.String({ minLength: 1 }), text: Type.Optional(Type.String({ maxLength: 24000 })),
  delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })) }, { additionalProperties: false });
const validChat = schema(chatSchema);
const approvalSchema = Type.Object({ agentId: Type.String({ minLength: 1 }), requestId: Type.String({ minLength: 1 }),
  optionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) }, { additionalProperties: false });
const validApproval = schema(approvalSchema);
const usage = '用法：/pbot status | init | agent {"action":…} | chat {"agentId":…,"text":…} | team {"action":…} | messages {"teamId":…} | post {"teamId":…,"text":…} | history {"action":…} | records {"agentId":…}';

export function registerDshCommand(ctx: Context, workspaces: DshWorkspaces, management: PbotManagement) {
  ctx.commands.register({ name: "pbot", description: "Personal Bot 工作区与协作管理", recordInput: false,
    input: { hint: "status | init | agent/chat/team/messages/post/history/records JSON", attachments: true },
    async handler({ agent, rawInput, signal, attachments, commandId }) {
      signal.throwIfAborted();
      const command = rawInput.trim(), split = command.search(/\s/);
      if (!command || command === "status") {
        requireThat(!attachments.length, "状态查询不接受附件。");
        const status = await dshWorkspaceStatus(workspaces, agent);
        signal.throwIfAborted(); return { kind: "success", text: JSON.stringify(status, null, 2) };
      }
      if (command === "init") {
        requireThat(!attachments.length, "初始化不接受附件。");
        await workspaces.initialize(agent);
        signal.throwIfAborted();
        return { kind: "success", text: JSON.stringify(await dshWorkspaceStatus(workspaces, agent), null, 2) };
      }
      const workspace = await workspaces.get(agent);
      signal.throwIfAborted();
      const verb = split < 0 ? command : command.slice(0, split);
      requireThat(verb === "chat" || !attachments.length, "输入框附件仅用于 chat 人工对话。");
      requireThat(split >= 0, usage);
      const input: unknown = JSON.parse(command.slice(split));
      requireThat(object(input), "命令参数必须是 JSON 对象。");
      let result: unknown;
      switch (verb) {
        case "agent": {
          const selection = agent.model.current();
          const output = await executeAgent(workspace.agents, agentInput(input), workspace.owner, selection ? {
            provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort ? { thinking: selection.reasoningEffort } : {}),
          } : {});
          result = output.structuredContent; break;
        }
        case "chat": {
          requireThat(validChat(input), "人工对话参数无效。");
          const args = input as Static<typeof chatSchema>;
          result = await workspace.interact(args.agentId, args.text ?? "", args.delivery, args.files, attachments, signal); break;
        }
        case "approval": {
          requireThat(validApproval(input), "ACP 确认答复参数无效。");
          const args = input as Static<typeof approvalSchema>;
          workspace.agents.answerPermission(args.agentId, args.requestId, args.optionId, workspace.owner);
          result = { answered: true }; break;
        }
        case "team":
          result = executeTeam(workspace.teams, workspace.agents, teamInput(input), workspace.owner).structuredContent; break;
        case "messages":
          result = executeTeamMessage(workspace.teams, teamMessageInput({ ...input, action: "read" }),
            { kind: "coordinator", owner: workspace.owner }, commandId).structuredContent; break;
        case "post":
          result = executeTeamMessage(workspace.teams, teamMessageInput({ ...input, action: "post" }),
            { kind: "user", owner: workspace.owner }, commandId).structuredContent; break;
        case "history": result = await management.history({ parentSessionId: agent.id, input: json(input) }, signal); break;
        case "records": result = await management.expert({ parentSessionId: agent.id, input: json(input) }, signal); break;
        default: throw new Error(usage);
      }
      workspace.check();
      return { kind: "success", text: JSON.stringify(result, null, 2) };
    },
  });
}
