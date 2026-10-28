import { Type } from "typebox";
import type { TSchema } from "typebox";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 24000 });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
const mode = Type.Union([Type.Literal("roundRobin"), Type.Literal("parallel")]);
const members = Type.Array(Type.Object({ agentId: id, role: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 50 });
const run = { instruction: text, mode, rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })) };
const page = { afterSeq: Type.Optional(Type.Integer({ minimum: 0 })), seq: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) };
const object = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const teamParametersSchema = object({
  action: Type.Union(["create", "list", "status", "read", "run", "pause", "close"].map(v => Type.Literal(v))),
  teamId: Type.Optional(id), name: Type.Optional(name), brief: Type.Optional(text), members: Type.Optional(members),
  instruction: Type.Optional(text), mode: Type.Optional(mode), rounds: run.rounds, maxConcurrent: run.maxConcurrent, timeoutSeconds: run.timeoutSeconds, ...page,
});
export const teamActionSchema = Type.Union([
  object({ action: Type.Literal("create"), name, brief: text, members }),
  object({ action: Type.Literal("list") }),
  ...["status", "pause", "close"].map(v => object({ action: Type.Literal(v), teamId: id })),
  object({ action: Type.Literal("run"), teamId: id, ...run }),
  object({ action: Type.Literal("read"), teamId: id, ...page }),
]);
export const teamMessageParametersSchema = object({
  action: Type.Union([Type.Literal("read"), Type.Literal("post")]), teamId: id, text: Type.Optional(text),
  replyTo: Type.Optional(Type.Integer({ minimum: 1 })), ...page,
});
export const teamMessageActionSchema = Type.Union([
  object({ action: Type.Literal("read"), teamId: id, ...page }),
  object({ action: Type.Literal("post"), teamId: id, text, replyTo: Type.Optional(Type.Integer({ minimum: 1 })) }),
]);
const nullableInteger = Type.Union([Type.Integer(), Type.Null()]);
const message = object({ seq: Type.Integer(), operationId: Type.String(),
  author: object({ kind: Type.Union([Type.Literal("user"), Type.Literal("coordinator"), Type.Literal("member")]), agentId: Type.Optional(id), name: Type.String() }),
  text: Type.String(), replyTo: Type.Optional(Type.Integer()), runId: Type.Optional(id),
  source: Type.Optional(object({ requestId: id, cycleId: id })),
  offset: Type.Integer(), totalLength: Type.Integer(), nextOffset: nullableInteger });
export const teamPageSchema = object({ teamId: id, messages: Type.Array(message), lastSeq: Type.Integer(), nextAfterSeq: nullableInteger });
const ownedView = object({ teamId: id, name: Type.String(), brief: Type.String(), closed: Type.Boolean(), owned: Type.Literal(true),
  members: Type.Array(object({ agentId: id, role: Type.String(), name: Type.String(), state: Type.String() })),
  lastSeq: Type.Integer(), activeCount: Type.Integer(),
  unresolved: Type.Array(object({ requestId: id, agentId: id, runId: id, round: Type.Integer(), active: Type.Boolean(), state: Type.String(), cycleId: Type.Optional(id) })),
  run: Type.Optional(object({ runId: id, instruction: Type.String(), mode, state: Type.Union([Type.Literal("running"), Type.Literal("paused"), Type.Literal("finished")]),
    rounds: Type.Integer(), maxConcurrent: Type.Integer(), deadlineAt: Type.Number(), scheduled: Type.Integer(), published: Type.Integer(), reason: Type.Optional(Type.String()) })) });
const view = Type.Union([ownedView, object({ teamId: id, name: Type.String(), closed: Type.Boolean(), owned: Type.Literal(false) })]);
export const teamResultSchema = Type.Union([view, object({ teams: Type.Array(view) }), teamPageSchema]);
export const teamMessageResultSchema = Type.Union([teamPageSchema, object({ teamId: id, seq: Type.Integer(), status: Type.Literal("stored") })]);
