import { Type } from "typebox";
import type { HistoryHost } from "../../model/history.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

const host = Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")]);
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
const node = Type.Object({ host, id: Type.String(),
  kind: Type.Union([Type.Literal("session"), Type.Literal("exchange"), Type.Literal("summary")], { description: "session=会话根；summary=摘要；exchange=单轮问答原文。" }),
  sessionId: Type.String(), name: Type.String(), preview: Type.String(), from: Type.String(), to: Type.String(),
  ready: Type.Boolean({ description: "正文或摘要是否已生成。" }),
  completed: Type.Boolean({ description: "该对话或问答是否正常结束（false 表示中断或未完）。" }) });
export const historyResultSchema = Type.Object({
  matches: Type.Optional(Type.Array(Type.Object({ ...node.properties, snippet: Type.String(), parents: Type.Array(Type.String()) }))),
  total: Type.Optional(Type.Integer()), nextOffset: Type.Optional(nullableOffset),
  node: Type.Optional(Type.Object({ ...node.properties, text: Type.String(), totalLength: Type.Integer(), nextOffset: nullableOffset,
    parents: Type.Array(node), children: Type.Array(node), nextChildrenOffset: nullableOffset,
    source: Type.Object({ host, sessionId: Type.String({ description: "原始宿主会话 ID。" }), entryIds: Type.Array(Type.String()) }), warnings: Type.Array(Type.String()) })),
  warnings: Type.Array(Type.String()),
});
export const historyDescription = "查询当前工作区的历史问答与归档，host 可筛选来源（pi/dsh/claude）。search 按不区分大小写的连续关键词匹配原文和摘要，省略 query 列出各会话；无匹配时换词。read 按节点 id 展开正文与上下级，nextOffset 续读正文，nextChildrenOffset 续读子节点；需要细节时读取 exchange 原文。归档不含工具调用日志。";
export const historyParameters = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "search 搜索或列会话；read 读取指定节点正文与上下级。各动作仅读取自身字段，其余字段忽略。" }),
  host: nullable(Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")], { description: "可选来源筛选：pi、dsh 或 claude。" })),
  query: nullable(Type.String({ description: "仅 search：不区分大小写的连续关键词；省略时列出各会话。" })),
  sessionId: nullable(Type.String({ description: "仅 search：限定在指定会话 ID 内搜索。" })),
  from: nullable(Type.String({ description: "仅 search：ISO 日期或时间下界。" })),
  to: nullable(Type.String({ description: "仅 search：ISO 日期或时间上界。" })),
  id: nullable(Type.String({ description: "仅 read，必填：search 或上下级返回的节点 id。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "search：匹配结果偏移；read：正文字符偏移。默认 0。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: 24000, description: "search：最多返回条数（默认 20，上限 50）；read：正文字符数（默认 12000）。" })),
  childrenOffset: nullable(Type.Integer({ minimum: 0, description: "仅 read：子节点列表偏移，默认 0；续读传上页 nextChildrenOffset。" })),
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
