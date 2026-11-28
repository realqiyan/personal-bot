import { Type } from "typebox";
import { historyPageLimits, type HistoryHost, type HistoryQuery } from "../../model/history.js";
import { historyIdentifierPattern, requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

const identifier = Type.String({ pattern: historyIdentifierPattern.source });
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
const node = Type.Object({
  host: identifier,
  id: Type.String(),
  kind: Type.Union([Type.Literal("session"), Type.Literal("exchange"), Type.Literal("summary")], {
    description: "session=会话根；summary=维度摘要；exchange=单轮问答原文。",
  }),
  dimension: Type.Optional(identifier),
  sessionId: Type.String(),
  name: Type.String(),
  preview: Type.String(),
  from: Type.String(),
  to: Type.String(),
  ready: Type.Boolean({ description: "正文或摘要是否已生成。" }),
  completed: Type.Boolean({ description: "该对话或问答是否正常结束（false 表示中断或未完）。" }),
});

export const historyResultSchema = Type.Object({
  matches: Type.Optional(Type.Array(Type.Object({
    ...node.properties,
    snippet: Type.String(),
    parents: Type.Array(Type.String()),
  }))),
  total: Type.Optional(Type.Integer()),
  nextOffset: Type.Optional(nullableOffset),
  node: Type.Optional(Type.Object({
    ...node.properties,
    text: Type.String(),
    totalLength: Type.Integer(),
    nextOffset: nullableOffset,
    parents: Type.Array(node),
    children: Type.Array(node),
    nextChildrenOffset: nullableOffset,
    source: Type.Object({
      host: identifier,
      sessionId: Type.String({ description: "原始宿主会话 ID。" }),
      entryIds: Type.Array(Type.String()),
      dimension: Type.Optional(identifier),
    }),
    warnings: Type.Array(Type.String()),
  })),
  warnings: Type.Array(Type.String()),
});

export const historyDescription =
  "查询当前工作区跨宿主历史问答与摘要归档。" +
  "search 按不区分大小写的连续关键词匹配原文与摘要，省略 query 列出各会话或指定维度摘要；" +
  "read 按 id 读取正文与上下级（可从 monthly 汇总下钻至 session 摘要和 exchange 原文），用 nextOffset 与 nextChildrenOffset 分页续读。";

export const historyParameters = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("read")], {
    description: "search 搜索或列表；read 按 id 读取正文与上下级。仅读取对应动作参数，其余忽略。",
  }),
  host: nullable(Type.String({ pattern: historyIdentifierPattern.source, description: "来源宿主筛选（如 pi、dsh、claude、antigravity、codex、qoder）；省略查全部。" })),
  dimension: nullable(Type.String({ pattern: historyIdentifierPattern.source, description: "仅 search：raw 仅原文，或指定摘要维度（如 monthly、session）；省略查全部。" })),
  query: nullable(Type.String({ description: "仅 search：连续关键词（不区分大小写）；省略列会话或指定维度摘要。" })),
  sessionId: nullable(Type.String({ description: "仅 search：限定在指定原始会话 ID 内搜索。" })),
  from: nullable(Type.String({ description: "仅 search：ISO 日期或时间下界。" })),
  to: nullable(Type.String({ description: "仅 search：ISO 日期或时间上界。" })),
  id: nullable(Type.String({ description: "仅 read，必填：节点 id（来自 search 或上下级）。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "search 为结果偏移，read 为正文字符偏移；默认 0。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: historyPageLimits.read.max, description: `search：返回条数（1–${historyPageLimits.search.max}，默认 ${historyPageLimits.search.default}）；read：正文字符数（默认 ${historyPageLimits.read.default}）。` })),
  childrenOffset: nullable(Type.Integer({ minimum: 0, description: "仅 read：子节点偏移，默认 0；续读传上次 nextChildrenOffset。" })),
}, { additionalProperties: false });

export type HistoryInput =
  | ({ action: "search" } & HistoryQuery)
  | { action: "read"; id: string; host?: HistoryHost; offset?: number; limit?: number; childrenOffset?: number };

const valid = schema(historyParameters);

export function historyInput(value: unknown): HistoryInput {
  const args = inputObject(value, valid, "历史参数格式无效");
  if (args.action === "search") {
    const limit = args.limit === undefined ? historyPageLimits.search.default : args.limit as number;
    requireThat(limit <= historyPageLimits.search.max, `search 的 limit 最多 ${historyPageLimits.search.max}。`);
    return {
      action: "search",
      ...(pick(args, ["host", "dimension", "query", "sessionId", "from", "to", "offset", "limit"]) as
        Omit<Extract<HistoryInput, { action: "search" }>, "action">),
    };
  }
  if (args.action === "read") {
    return {
      action: "read",
      id: need("read", args, "id"),
      ...(pick(args, ["host", "offset", "limit", "childrenOffset"]) as
        Omit<Extract<HistoryInput, { action: "read" }>, "action" | "id">),
    };
  }
  throw new Error("未知的历史 action。");
}
