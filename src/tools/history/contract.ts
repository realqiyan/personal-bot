import { Type, type Static } from "typebox";
import { requireThat, schema } from "../../common/validation.js";

const host = Type.Union([Type.Literal("pi"), Type.Literal("dsh")]);
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
const node = Type.Object({ host, id: Type.String(), kind: Type.Union([Type.Literal("session"), Type.Literal("exchange"), Type.Literal("summary")]),
  sessionId: Type.String(), name: Type.String(), preview: Type.String(), from: Type.String(), to: Type.String(), ready: Type.Boolean(), completed: Type.Boolean() });
export const historyResultSchema = Type.Object({
  matches: Type.Optional(Type.Array(Type.Object({ ...node.properties, snippet: Type.String(), parents: Type.Array(Type.String()) }))),
  total: Type.Optional(Type.Integer()), nextOffset: Type.Optional(nullableOffset),
  node: Type.Optional(Type.Object({ ...node.properties, text: Type.String(), totalLength: Type.Integer(), nextOffset: nullableOffset,
    parents: Type.Array(node), children: Type.Array(node), nextChildrenOffset: nullableOffset,
    source: Type.Object({ host, sessionId: Type.String({ description: "原始宿主会话 ID；来源不保存文件路径。" }), entryIds: Type.Array(Type.String()) }), warnings: Type.Array(Type.String()) })),
  warnings: Type.Array(Type.String()),
});
export const historyDescription = "查询当前工作区的 Pi 与 dsh 历史归档，可用 host 筛选来源。search 对问答原文和各层摘要做不区分大小写的连续文本匹配；省略 query 列出会话。忘记原词时换几组词查询。read 读取命中节点并返回父子节点；沿 parents/children 的 id 展开，nextOffset 续读正文，nextChildrenOffset 续读子节点。摘要是检索线索，重要结论回到 exchange 原文核对。共享前缀可能有多个父节点。查询不调用模型，不恢复或重放旧任务；只更新当前宿主的原生历史索引。问答归档不代替专家的完整工具日志。";
export const historyParameters = Type.Object({ action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
  host: Type.Optional(host), query: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
  from: Type.Optional(Type.String({ description: "search：ISO 日期或时间，下界。" })),
  to: Type.Optional(Type.String({ description: "search：ISO 日期或时间，上界。" })),
  id: Type.Optional(Type.String({ description: "read 必填：返回的节点 id。" })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000, description: "search：最多 50 条，默认 20；read：字符数，默认 12000。" })),
  childrenOffset: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type HistoryInput = Static<typeof historyParameters>;
const valid = schema(historyParameters);
export function historyInput(value: unknown): HistoryInput {
  requireThat(valid(value), "历史参数无效。");
  const args = value as HistoryInput;
  requireThat(args.action !== "read" || args.id, "read 需要节点 id。");
  requireThat(args.action !== "search" || (args.limit ?? 20) <= 50, "search limit 最多 50。");
  return args;
}
