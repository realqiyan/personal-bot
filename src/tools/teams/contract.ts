import { Type } from "typebox";
import type { TSchema } from "typebox";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

export const teamDescription = "组织固定原生专家成员协作。create 建立团队，run 发起一批讨论；运行时占用成员，pause 停止新安排并允许在途工作收尾（之后可私人 send），中止成员用 pbot_agent stop。close 保留成员和历史；换成员须先 close 再重建。状态用 status，公共原文用 pbot_team_message read/post。";
export const teamMessageDescription = "读写团队公共原文。post 向全体成员发布消息（成员仅可在自己的团队工作中 post；安排讨论由主会话调 pbot_team run）。read 用 afterSeq 翻页，长正文按 seq/offset 续读，先补完 nextOffset 非空的消息。";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 24000 });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$", description: "仅 create，必填：团队名称。" });
const mode = Type.Union([Type.Literal("roundRobin"), Type.Literal("parallel")], { description: "仅 run，必填：roundRobin 按顺序轮流发言；parallel 在并发上限内并行，本轮全员完成后进入下一轮。" });
const members = Type.Array(Type.Object({ agentId: id, role: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }), {
  minItems: 1, maxItems: 50, description: "仅 create，必填：当前分支中的固定原生专家成员及职责，且未加入其他未关闭团队（ACP 专家不可加入团队）。",
});
const runFields = {
  instruction: nullable(Type.String({ ...text, description: "仅 run，必填：本批次的任务、约束与交付要求。" })),
  mode: nullable(mode),
  rounds: nullable(Type.Integer({ minimum: 1, maximum: 10, description: "仅 run：每位成员的发言轮数，默认 2。" })),
  maxConcurrent: nullable(Type.Integer({ minimum: 1, maximum: 50, description: "仅 run：并发上限。roundRobin 只能为 1；parallel 默认 min(2, 成员数)，不得超过成员数。" })),
  timeoutSeconds: nullable(Type.Integer({ minimum: 1, maximum: 86400, description: "仅 run：整批期限，默认 900 秒（含所有轮次与等待）。到期停止新安排并尝试中止未人工接管的工作，之后须查状态确认。" })),
};
const object = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const teamParametersSchema = object({
  action: Type.Union(["create", "list", "status", "run", "pause", "close"].map(value => Type.Literal(value)), {
    description: "create 必填 name/brief/members；list 只需 action；status/pause/close 必填 teamId；run 必填 teamId/instruction/mode（可选 rounds/maxConcurrent/timeoutSeconds），要求成员均存活且 idle、团队未关闭且无在途工作；close 前须先 pause 并等待在途结束。各动作仅读取自身字段，其余字段忽略。",
  }),
  teamId: nullable(Type.String({ ...id, description: "status/run/pause/close 必填：团队 ID。" })),
  name: nullable(name),
  brief: nullable(Type.String({ ...text, description: "仅 create，必填：团队共同目标与背景（各轮成员均可见）；单批任务要求填在 run 的 instruction。" })),
  members: nullable(members), ...runFields,
});

export type TeamMember = { agentId: string; role: string };
export type TeamInput =
  | { action: "create"; name: string; brief: string; members: TeamMember[] }
  | { action: "list" }
  | { action: "status" | "pause" | "close"; teamId: string }
  | { action: "run"; teamId: string; instruction: string; mode: "roundRobin" | "parallel"; rounds?: number; maxConcurrent?: number; timeoutSeconds?: number };

const validTeam = schema(teamParametersSchema);

export function teamInput(value: unknown): TeamInput {
  const args = inputObject(value, validTeam, "团队参数格式无效");
  const action = args.action as TeamInput["action"];
  switch (action) {
    case "create":
      return { action, name: need("create", args, "name"), brief: need("create", args, "brief"), members: need("create", args, "members") };
    case "list":
      return { action };
    case "status":
    case "pause":
    case "close":
      return { action, teamId: need(action, args, "teamId") };
    case "run":
      return { action, teamId: need("run", args, "teamId"), instruction: need("run", args, "instruction"), mode: need("run", args, "mode"),
        ...(args.rounds === undefined ? {} : { rounds: args.rounds as number }),
        ...(args.maxConcurrent === undefined ? {} : { maxConcurrent: args.maxConcurrent as number }),
        ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds as number }) };
    default:
      throw new Error("未知的团队 action。");
  }
}

const page = {
  afterSeq: nullable(Type.Integer({ minimum: 0, description: "仅 read：读取序号大于此值的消息，默认 0，不得超过 lastSeq。续页传上页返回的 nextAfterSeq；单条续读用 seq/offset 且省略 afterSeq。" })),
  seq: nullable(Type.Integer({ minimum: 1, description: "仅 read：指定单条消息序号，配合 nextOffset 续读；未指定时按 afterSeq 顺序读取。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "仅 read：指定 seq 的正文字符偏移，默认 0；非零时须同时传 seq。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：本页正文合计字符上限，默认 16000。" })),
};
export const teamMessageParametersSchema = object({
  action: Type.Union([Type.Literal("read"), Type.Literal("post")], {
    description: "read 必填 teamId（可选 afterSeq/seq/offset/limit）；post 必填 teamId/text（可选 replyTo）。各动作仅读取自身字段，其余字段忽略。",
  }), teamId: nullable(Type.String({ ...id, description: "必填：团队 ID。" })), text: nullable(Type.String({ ...text, description: "仅 post，必填：向全体成员公开的正文。" })),
  replyTo: nullable(Type.Integer({ minimum: 1, description: "仅 post：回复已有消息的 seq。" })), ...page,
});

export type TeamMessageInput =
  | { action: "read"; teamId: string; afterSeq?: number; seq?: number; offset?: number; limit?: number }
  | { action: "post"; teamId: string; text: string; replyTo?: number };

const validMessage = schema(teamMessageParametersSchema);

export function teamMessageInput(value: unknown): TeamMessageInput {
  const args = inputObject(value, validMessage, "团队消息参数格式无效");
  if (args.action === "read") return { action: "read", teamId: need("read", args, "teamId"),
    ...(pick(args, ["afterSeq", "seq", "offset", "limit"]) as Pick<Extract<TeamMessageInput, { action: "read" }>, "afterSeq" | "seq" | "offset" | "limit">) };
  if (args.action === "post") return { action: "post", teamId: need("post", args, "teamId"), text: need("post", args, "text"),
    ...(args.replyTo === undefined ? {} : { replyTo: args.replyTo as number }) };
  throw new Error("未知的团队消息 action。");
}

const message = object({ seq: Type.Integer(), operationId: Type.String(),
  author: object({ kind: Type.Union([Type.Literal("user"), Type.Literal("coordinator"), Type.Literal("member")]), agentId: Type.Optional(id), name: Type.String() }),
  text: Type.String(), replyTo: Type.Optional(Type.Integer()), runId: Type.Optional(id),
  source: Type.Optional(object({ requestId: id, cycleId: id })),
  offset: Type.Integer(), totalLength: Type.Integer({ description: "完整正文字符数。" }),
  nextOffset: Type.Union([Type.Integer(), Type.Null()], { description: "非 null 表示本条正文未读完；用相同 teamId、seq 和此 offset 续读。" }) });
export const teamPageSchema = object({ teamId: id, messages: Type.Array(message), lastSeq: Type.Integer(),
  nextAfterSeq: Type.Union([Type.Integer(), Type.Null()], { description: "后续消息列表的 afterSeq；null 只表示列表已到末尾，仍须检查每条消息的 nextOffset。指定 seq 时始终为 null。" }) });
const ownedView = object({ teamId: id, name: Type.String(), brief: Type.String(), closed: Type.Boolean(), owned: Type.Literal(true),
  members: Type.Array(object({ agentId: id, role: Type.String(), name: Type.String(), state: Type.String() })),
  lastSeq: Type.Integer(), activeCount: Type.Integer({ description: "各批次仍在途的请求数；paused 时也可能大于 0。" }),
  unresolved: Type.Array(object({ requestId: id, agentId: id, runId: id, round: Type.Integer(), active: Type.Boolean(),
    state: Type.String({ description: "queued=待处理；accepted=在途；uncertain=结果未确认；cancelled=未执行或已取消；unpublished=已完成但结果尚未公开；mixed/interactive=含人工或私人工作，不自动公开；failed/interrupted=失败或中断。" }), cycleId: Type.Optional(id) }), {
    description: "各批次尚未确认完成且公开的请求。先核对原请求和实际结果，再决定后续操作，避免重复执行。",
  }),
  run: Type.Optional(object({ runId: id, instruction: Type.String(), mode, state: Type.Union([Type.Literal("running"), Type.Literal("paused"), Type.Literal("finished")]),
    rounds: Type.Integer(), maxConcurrent: Type.Integer(), deadlineAt: Type.Number(), scheduled: Type.Integer(), published: Type.Integer(), reason: Type.Optional(Type.String()) })) });
const view = Type.Union([ownedView, object({ teamId: id, name: Type.String(), closed: Type.Boolean(), owned: Type.Literal(false) })]);
export const teamResultSchema = Type.Union([view, object({ teams: Type.Array(view) })]);
export const teamMessageResultSchema = Type.Union([teamPageSchema, object({ teamId: id, seq: Type.Integer(), status: Type.Literal("stored") })]);
