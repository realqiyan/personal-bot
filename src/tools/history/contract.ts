import { Type } from "typebox";
import type { HistoryHost } from "../../model/history.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

const host = Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")]);
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
const node = Type.Object({ host, id: Type.String(), kind: Type.Union([Type.Literal("session"), Type.Literal("exchange"), Type.Literal("summary")]),
  sessionId: Type.String(), name: Type.String(), preview: Type.String(), from: Type.String(), to: Type.String(), ready: Type.Boolean(), completed: Type.Boolean() });
export const historyResultSchema = Type.Object({
  matches: Type.Optional(Type.Array(Type.Object({ ...node.properties, snippet: Type.String(), parents: Type.Array(Type.String()) }))),
  total: Type.Optional(Type.Integer()), nextOffset: Type.Optional(nullableOffset),
  node: Type.Optional(Type.Object({ ...node.properties, text: Type.String(), totalLength: Type.Integer(), nextOffset: nullableOffset,
    parents: Type.Array(node), children: Type.Array(node), nextChildrenOffset: nullableOffset,
    source: Type.Object({ host, sessionId: Type.String({ description: "原始宿主会话 ID。" }), entryIds: Type.Array(Type.String()) }), warnings: Type.Array(Type.String()) })),
  warnings: Type.Array(Type.String()),
});
export const historyDescription = "查询当前工作区的 Pi/dsh 问答与已有 Claude 归档，host 可筛选来源。search 按不区分大小写的连续文本匹配原文和摘要；无匹配时换词，省略 query 列会话。read 按 parents/children 的 id 展开，nextOffset 续读正文，nextChildrenOffset 续读子节点。需要对话细节时读取 exchange 原文；需要工具日志时查所属宿主的原始会话。";
export const historyParameters = Type.Object({ action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
  host: nullable(host), query: nullable(Type.String()), sessionId: nullable(Type.String()),
  from: nullable(Type.String({ description: "search：ISO 日期或时间，下界。" })),
  to: nullable(Type.String({ description: "search：ISO 日期或时间，上界。" })),
  id: nullable(Type.String({ description: "read 必填：返回的节点 id。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "search：匹配结果偏移；read：正文 UTF-16 字符偏移。默认 0。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: 24000, description: "search：最多返回的匹配条数，默认 20，最多 50；read：正文 UTF-16 字符数，默认 12000。" })),
  childrenOffset: nullable(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export type HistoryInput =
  | { action: "search"; host?: HistoryHost; query?: string; sessionId?: string; from?: string; to?: string; offset?: number; limit?: number }
  | { action: "read"; id: string; host?: HistoryHost; offset?: number; limit?: number; childrenOffset?: number };

const valid = schema(historyParameters);

export function historyInput(value: unknown): HistoryInput {
  const args = inputObject(value, valid, "历史参数格式无效");
  if (args.action === "search") {
    const limit = args.limit === undefined ? 20 : args.limit as number;
    requireThat(limit <= 50, "search 的 limit 最多 50。");
    return { action: "search", ...(pick(args, ["host", "query", "sessionId", "from", "to", "offset", "limit"]) as
      Omit<Extract<HistoryInput, { action: "search" }>, "action">) };
  }
  if (args.action === "read") return { action: "read", id: need("read", args, "id"),
    ...(pick(args, ["host", "offset", "limit", "childrenOffset"]) as
      Omit<Extract<HistoryInput, { action: "read" }>, "action" | "id">) };
  throw new Error("未知的历史 action。");
}
