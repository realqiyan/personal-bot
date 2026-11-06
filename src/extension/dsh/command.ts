import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { Type, type Static } from "typebox";
import { object, json } from "../../common/json.js";
import { requireThat, schema } from "../../common/validation.js";
import { prepareWorkspace } from "../../services/workspace/workspace-preparation.js";
import { executeAgent, type AgentInput } from "../../tools/agents/actions.js";
import { dshAgentActionSchema } from "../../tools/agents/dsh-contract.js";
import { executeTeam, executeTeamMessage } from "../../tools/teams/actions.js";
import { teamActionSchema, teamParametersSchema, teamMessageActionSchema, teamMessageParametersSchema } from "../../tools/teams/contract.js";
import { dshStatus, type PbotManagement } from "./management.js";
import type { DshWorkspaces } from "./workspace.js";

const validAgent = schema(dshAgentActionSchema), validTeam = schema(teamActionSchema), validMessage = schema(teamMessageActionSchema);
const chatSchema = Type.Object({ agentId: Type.String({ minLength: 1 }), text: Type.Optional(Type.String({ maxLength: 24000 })),
  delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })) }, { additionalProperties: false });
const validChat = schema(chatSchema);
const usage = '用法：/pbot status | init | python setup | agent {"action":…} | chat {"agentId":…,"text":…} | team {"action":…} | post {"teamId":…,"text":…} | history {"action":…} | records {"agentId":…}';

export function registerDshCommand(ctx: Context, workspaces: DshWorkspaces, management: PbotManagement) {
  ctx.commands.register({ name: "pbot", description: "Personal Bot 工作区与协作管理", recordInput: false,
    input: { hint: "status | init | python setup | agent/chat/team/post/history/records JSON", attachments: true },
    async handler({ agent, rawInput, signal, attachments, commandId }) {
      signal.throwIfAborted();
      const workspace = await workspaces.get(agent);
      signal.throwIfAborted();
      const command = rawInput.trim(), split = command.search(/\s/);
      const verb = split < 0 ? command : command.slice(0, split);
      requireThat(verb === "chat" || !attachments.length, "输入框附件仅用于 chat 人工对话。");
      if (command === "init") {
        await prepareWorkspace(workspace.root); workspace.check();
        return { kind: "success", text: "资料目录已准备；已有文件保留。" };
      }
      if (command === "python setup") {
        const result = await workspaces.preparePython(); workspace.check();
        return { kind: "success", text: JSON.stringify(result, null, 2) };
      }
      if (!command || command === "status") return { kind: "success", text: JSON.stringify(dshStatus(workspaces, workspace), null, 2) };
      requireThat(split >= 0, usage);
      const input: unknown = JSON.parse(command.slice(split));
      requireThat(object(input), "命令参数必须是 JSON 对象。");
      let result: unknown;
      switch (verb) {
        case "agent": {
          requireThat(validAgent(input), "dsh 专家参数无效或包含不支持的宿主选项。");
          const selection = agent.model.current();
          const output = await executeAgent(workspace.agents, input as AgentInput, workspace.owner, selection ? {
            provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort && (!input.provider || input.provider === selection.provider) && (!input.model || input.model === selection.model)
              ? { thinking: selection.reasoningEffort } : {}),
          } : {});
          result = output.structuredContent; break;
        }
        case "chat": {
          requireThat(validChat(input), "人工对话参数无效。");
          const args = input as Static<typeof chatSchema>;
          result = await workspace.expert(args.agentId).interact(args.text ?? "", args.delivery, args.files, attachments, signal); break;
        }
        case "team": {
          requireThat(validTeam(input), "团队参数无效。");
          result = executeTeam(workspace.teams, workspace.agents, input as Static<typeof teamParametersSchema>, workspace.owner).structuredContent; break;
        }
        case "post": {
          const args = { ...input, action: "post" as const };
          requireThat(input.action === undefined && validMessage(args), "公共消息参数无效。");
          result = executeTeamMessage(workspace.teams, args as Static<typeof teamMessageParametersSchema>,
            { kind: "user", owner: workspace.owner }, commandId).structuredContent; break;
        }
        case "history": result = await management.history({ parentSessionId: agent.id, input: json(input) }, signal); break;
        case "records": result = await management.expert({ parentSessionId: agent.id, input: json(input) }, signal); break;
        default: throw new Error(usage);
      }
      workspace.check();
      return { kind: "success", text: JSON.stringify(result, null, 2) };
    },
  });
}
