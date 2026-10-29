import { Type } from "typebox";
import type { TSchema } from "typebox";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 24000 });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
const mode = Type.Union([Type.Literal("roundRobin"), Type.Literal("parallel")], { description: "run 必填：roundRobin 按成员顺序轮流发言；parallel 在并发上限内发言，全员本轮完成后才进入下一轮。" });
const members = Type.Array(Type.Object({ agentId: id, role: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }), {
  minItems: 1, maxItems: 50, description: "仅 create，必填：固定成员及职责。成员须属于当前父会话分支、版本兼容且未加入其他未关闭团队。create 不启动模型，也不等待成员就绪。",
});
const run = {
  instruction: Type.String({ ...text, description: "仅 run，必填：本次新批次的明确任务与交付要求；不恢复或重放旧批次。" }), mode,
  rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "仅 run：每位成员的轮数，默认 2。" })),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "仅 run：roundRobin 默认且只允许 1；parallel 默认 min(2, 成员数)。不得超过成员数；已排队但未完成的请求也占用并发名额。" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400, description: "仅 run：整批期限，默认 900 秒，包含所有轮次和等待。到期停止新安排和领取，子入口尽力中止未被人工接管的在途工作；pause 则允许在途工作收尾。" })),
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
    description: "create 只接受并必填 name/brief/members；list 只接受 action；status/pause/close 只接受并必填 teamId；read 必填 teamId，可选 afterSeq/seq/offset/limit；run 必填 teamId/instruction/mode，可选 rounds/maxConcurrent/timeoutSeconds。禁止携带其他 action 的字段。run 要求所有成员存活、idle、当前代次团队接入就绪、无待处理私人输入，且团队未关闭、无运行批次或在途工作。pause 仅停止新安排和未领取请求；close 要求先暂停并等待在途工作结束，不停止成员进程。",
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
  }), teamId: id, text: Type.Optional(Type.String({ ...text, description: "仅 post，必填：向全体成员公开的原文，不扩大任务授权。" })),
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
  lastSeq: Type.Integer(), activeCount: Type.Integer({ description: "所有批次中已领取、进程仍存活且尚无完成记录的请求数；paused 仍可能大于 0。" }),
  unresolved: Type.Array(object({ requestId: id, agentId: id, runId: id, round: Type.Integer(), active: Type.Boolean(),
    state: Type.String({ description: "queued=运行批次中尚未领取；accepted=已领取且仍在途；uncertain=已领取但进程/代次不再匹配、无完成记录；cancelled=批次已停止且未领取，或周期取消；unpublished=已完成但尚未公开有效原文；mixed/interactive=含人工或私人工作，不自动公开；failed/interrupted=失败或中断。不能将 unresolved 当作成功或自动重试许可。" }), cycleId: Type.Optional(id) }), {
    description: "所有批次中尚未确认完成且公开的请求，包含排队、在途、失败、结果不明和不宜公开的工作；不是仅列出运行中的请求。先核对原请求和业务结果，避免重复执行。",
  }),
  run: Type.Optional(object({ runId: id, instruction: Type.String(), mode, state: Type.Union([Type.Literal("running"), Type.Literal("paused"), Type.Literal("finished")]),
    rounds: Type.Integer(), maxConcurrent: Type.Integer(), deadlineAt: Type.Number(), scheduled: Type.Integer(), published: Type.Integer(), reason: Type.Optional(Type.String()) })) });
const view = Type.Union([ownedView, object({ teamId: id, name: Type.String(), closed: Type.Boolean(), owned: Type.Literal(false) })]);
export const teamResultSchema = Type.Union([view, object({ teams: Type.Array(view) }), teamPageSchema]);
export const teamMessageResultSchema = Type.Union([teamPageSchema, object({ teamId: id, seq: Type.Integer(), status: Type.Literal("stored") })]);
