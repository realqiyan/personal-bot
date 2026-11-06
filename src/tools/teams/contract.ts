import { Type } from "typebox";

export const teamDescription = "组织固定成员协作。create 建立团队，run 开始一批讨论。运行时占用成员；pause 停止新安排，允许在途工作收尾，之后可私人 send；中止成员用 pbot_agent stop。close 保留成员和历史；换成员须关闭旧团队再创建。继续讨论用 run 提交新要求。成员最终答复向团队公开。";
export const teamMessageDescription = "读写团队公共原文。post 向全体成员发布信息，需要安排回答时由主会话调用 pbot_team run；成员只能在自己的团队工作中 post。read 用 afterSeq 翻页，长正文按 seq/offset 续读，先补完 nextOffset 非空的消息。";

import type { TSchema } from "typebox";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 24000 });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
const mode = Type.Union([Type.Literal("roundRobin"), Type.Literal("parallel")], { description: "run 必填：roundRobin 按成员顺序轮流发言；parallel 在并发上限内发言，全员本轮完成后才进入下一轮。" });
const members = Type.Array(Type.Object({ agentId: id, role: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }), {
  minItems: 1, maxItems: 50, description: "仅 create，必填：当前分支中的固定成员及职责；成员须版本兼容且未加入其他未关闭团队。",
});
const run = {
  instruction: Type.String({ ...text, description: "仅 run，必填：本批次的任务、约束与交付要求。" }), mode,
  rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "仅 run：每位成员的轮数，默认 2。" })),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "仅 run：roundRobin 默认且只允许 1；parallel 默认 min(2, 成员数)。不得超过成员数；待处理和执行中的发言都计入上限。" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400, description: "仅 run：整批期限，默认 900 秒，包含所有轮次和等待。到期停止安排并尝试中止尚未人工接管的工作，之后仍须核对实际状态；pause 则允许在途工作收尾。" })),
};
const page = {
  afterSeq: Type.Optional(Type.Integer({ minimum: 0, description: "仅 read：读取序号大于此值的消息，默认 0，不得超过 lastSeq。返回 nextAfterSeq 用于继续消息列表；单条续读使用 seq/offset，省略 afterSeq。先补完被截断的正文，再继续列表。" })),
  seq: Type.Optional(Type.Integer({ minimum: 1, description: "仅 read：指定一条消息，配合该消息的 nextOffset 续读。未指定时从 afterSeq 后顺序读取。" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "仅 read：指定 seq 的正文 UTF-16 字符偏移，默认 0；非零时必须同时提供 seq。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：本页所有消息正文合计的 UTF-16 字符上限，默认 16000，不是消息条数或 token 数；不含元数据和 Markdown 格式开销。" })),
};
const object = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const teamParametersSchema = object({
  action: Type.Union(["create", "list", "status", "read", "run", "pause", "close"].map(v => Type.Literal(v)), {
    description: "create 必填 name/brief/members；list 只接受 action；status/pause/close 必填 teamId；read 必填 teamId，可选 afterSeq/seq/offset/limit；run 必填 teamId/instruction/mode，可选 rounds/maxConcurrent/timeoutSeconds。只传对应 action 的字段。run 前须确认所有成员存活、idle、可参与团队且无待处理私人输入，团队未关闭，也无运行批次或在途工作。close 前先暂停并等待在途工作结束。",
  }),
  teamId: Type.Optional(id), name: Type.Optional(name), brief: Type.Optional(text), members: Type.Optional(members),
  instruction: Type.Optional(run.instruction), mode: Type.Optional(mode), rounds: run.rounds, maxConcurrent: run.maxConcurrent, timeoutSeconds: run.timeoutSeconds, ...page,
});
export const teamActionSchema = Type.Union([
  object({ action: Type.Literal("create"), name, brief: text, members }),
  object({ action: Type.Literal("list") }),
  ...["status", "pause", "close"].map(v => object({ action: Type.Literal(v), teamId: id })),
  object({ action: Type.Literal("run"), teamId: id, ...run }),
  object({ action: Type.Literal("read"), teamId: id, ...page }),
]);
export const teamMessageParametersSchema = object({
  action: Type.Union([Type.Literal("read"), Type.Literal("post")], {
    description: "read 必填 teamId，只可选 afterSeq/seq/offset/limit，禁止 text/replyTo；post 必填 teamId/text，只可选 replyTo，禁止所有分页字段。",
  }), teamId: id, text: Type.Optional(Type.String({ ...text, description: "仅 post，必填：向全体成员公开的原文。" })),
  replyTo: Type.Optional(Type.Integer({ minimum: 1, description: "仅 post：回复已有消息的 seq。" })), ...page,
});
export const teamMessageActionSchema = Type.Union([
  object({ action: Type.Literal("read"), teamId: id, ...page }),
  object({ action: Type.Literal("post"), teamId: id, text, replyTo: Type.Optional(Type.Integer({ minimum: 1 })) }),
]);
const message = object({ seq: Type.Integer(), operationId: Type.String(),
  author: object({ kind: Type.Union([Type.Literal("user"), Type.Literal("coordinator"), Type.Literal("member")]), agentId: Type.Optional(id), name: Type.String() }),
  text: Type.String(), replyTo: Type.Optional(Type.Integer()), runId: Type.Optional(id),
  source: Type.Optional(object({ requestId: id, cycleId: id })),
  offset: Type.Integer(), totalLength: Type.Integer({ description: "完整正文的 UTF-16 字符数。" }),
  nextOffset: Type.Union([Type.Integer(), Type.Null()], { description: "非 null 表示本条正文尚未读完；使用相同 teamId、seq 和此 offset 续读。" }) });
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
export const teamResultSchema = Type.Union([view, object({ teams: Type.Array(view) }), teamPageSchema]);
export const teamMessageResultSchema = Type.Union([teamPageSchema, object({ teamId: id, seq: Type.Integer(), status: Type.Literal("stored") })]);
