import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HistoryService } from "../../services/history/history-service.js";
import type { CallAccess } from "../access.js";
import { historyLocation } from "../../integrations/pi/history.js";
import { requireThat } from "../../common/validation.js";
import { markdownResult } from "../result.js";

const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
const node = Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal("session"), Type.Literal("exchange"), Type.Literal("summary")]),
  sessionId: Type.String(), name: Type.String(), preview: Type.String(), from: Type.String(), to: Type.String(), ready: Type.Boolean(), completed: Type.Boolean() });
const resultSchema = Type.Object({
  matches: Type.Optional(Type.Array(Type.Object({ ...node.properties, snippet: Type.String(), parents: Type.Array(Type.String()) }))),
  total: Type.Optional(Type.Integer()), nextOffset: Type.Optional(nullableOffset),
  node: Type.Optional(Type.Object({ ...node.properties, text: Type.String(), totalLength: Type.Integer(), nextOffset: nullableOffset,
    parents: Type.Array(node), children: Type.Array(node), nextChildrenOffset: nullableOffset,
    source: Type.Object({ file: Type.String({ description: "原生来源路径，相对工作区；跨机器后可能不存在，问答正文保存在工作区存档中。" }), entryIds: Type.Array(Type.String()) }), warnings: Type.Array(Type.String()) })),
  warnings: Type.Array(Type.String()),
});
export function historyTool(service: HistoryService, access: CallAccess) {
  return defineTool({ name: "pbot_history", label: "历史对话",
    description: "查询当前工作区的 Pi 历史。search 对问答原文和各层摘要做不区分大小写的连续文本匹配；省略 query 列出会话。忘记原词时换几组词查询。read 读取命中节点并返回父子节点；沿 parents/children 的 id 展开，nextOffset 续读正文，nextChildrenOffset 续读子节点。摘要是检索线索，重要结论回到 exchange 原文核对。共享前缀可能有多个父节点。查询不调用模型，不恢复或重放旧任务。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
      query: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
      from: Type.Optional(Type.String({ description: "search：ISO 日期或时间，下界。" })),
      to: Type.Optional(Type.String({ description: "search：ISO 日期或时间，上界。" })),
      id: Type.Optional(Type.String({ description: "read 必填：返回的节点 id。" })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000, description: "search：最多 50 条，默认 20；read：字符数，默认 12000。" })),
      childrenOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }), outputSchema: resultSchema,
    async execute(_id, args, signal, _update, ctx) {
      access.check(); signal?.throwIfAborted();
      requireThat(args.action !== "read" || args.id, "read 需要节点 id。");
      requireThat(args.action !== "search" || (args.limit ?? 20) <= 50, "search limit 最多 50。");
      await service.refresh(historyLocation(ctx), signal);
      access.check();
      return args.action === "search" ? markdownResult(service.search(args), "历史搜索")
        : markdownResult({ node: service.read(args.id!, args.offset, args.limit, args.childrenOffset), warnings: service.warnings }, "历史正文");
    },
  });
}
