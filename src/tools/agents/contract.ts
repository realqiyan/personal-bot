import { Type } from "typebox";
const id = Type.String({ minLength: 1, maxLength: 128 });
const message = Type.String({ minLength: 1, maxLength: 24000, description: "本次目标、交付要求、资料依据与约束。" });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
const options = {
  name: Type.Optional(name), message: Type.Optional(message),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "随初始消息读取的文件；相对路径基于原工作区根目录。" })),
  prompts: Type.Optional(Type.Array(message, { maxItems: 32, description: "与 message 按顺序合并为同一初始消息，不是多个执行轮次。" })),
  provider: Type.Optional(Type.String({ ...id, description: "Pi 模型提供方，默认继承主会话。" })),
  model: Type.Optional(Type.String({ ...id, description: "子进程可用的 Pi 模型 ID，默认继承主会话。" })),
  thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")], { description: "默认继承主会话思考级别。" })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "执行目录，相对原工作区根目录；省略时使用工作区根目录。" })),
  tools: Type.Optional(Type.Array(id, { minItems: 1, description: "按 Pi 原生规则选择工具，省略时沿用原生默认工具；MCP 工具遵循原生暴露设置。不提供递归委派；这不是宿主隔离。" })),
  noExtensions: Type.Optional(Type.Boolean({ description: "默认 true，不发现其他扩展。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "关闭技能发现，默认 false。" })),
  noPromptTemplates: Type.Optional(Type.Boolean({ description: "关闭提示模板发现，默认 false。" })),
  noContextFiles: Type.Optional(Type.Boolean({ description: "关闭 Pi 原生上下文文件加载，默认 false。" })),
};
const page = {
  cycleId: Type.Optional(Type.String({ ...id, description: "仅 read：省略时读取最近周期；按 nextOffset 续读时须固定为上页返回的 cycle.cycleId，避免切换到新周期。" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "仅 read：报告正文的 UTF-16 字符偏移，默认 0；续读使用上页 nextOffset。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：最多返回的正文 UTF-16 字符数，默认 16000，不是消息数或 token 数。" })),
};
const delivery = Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "send 默认 steer 补充当前工作；followUp 排到当前工作之后。" }));
export const agentParametersSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("rename"), Type.Literal("status"), Type.Literal("list"), Type.Literal("read"), Type.Literal("stop"), Type.Literal("resume")], {
    description: "start 仅接受启动选项，可省略 message/prompts/files 创建待命进程，禁止 agentId/delivery/分页字段；list 只接受 action；status/stop 只接受并必填 agentId；send 必填 agentId/message，仅可选 delivery；resume 必填 agentId/message；rename 必填 agentId/name；read 必填 agentId，仅可选 cycleId/offset/limit。禁止携带其他 action 的字段。",
  }),
  agentId: Type.Optional(id), ...options, ...page, delivery,
}, { additionalProperties: false });
export const agentActionSchema = Type.Union([
  Type.Object({ action: Type.Literal("start"), ...options }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("send"), agentId: id, message, delivery }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("rename"), agentId: id, name }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume"), agentId: id, message }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  ...["stop", "status"].map(action => Type.Object({ action: Type.Literal(action), agentId: id }, { additionalProperties: false })),
  Type.Object({ action: Type.Literal("read"), agentId: id, ...page }, { additionalProperties: false }),
]);

const cycle = Type.Object({ cycleId: Type.String(), startedAt: Type.Number(), finishedAt: Type.Optional(Type.Number()),
  state: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")], { description: "本周期的工作结果；completed 仍须核验实际交付。" }),
  requestIds: Type.Array(Type.String()),
  source: Type.Union([Type.Literal("parent"), Type.Literal("interactive"), Type.Literal("mixed")]), error: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const agentViewSchema = Type.Object({ agentId: Type.String(), name: Type.String(), cwd: Type.String(), createdAt: Type.Number(),
  owned: Type.Boolean({ description: "是否属于当前父会话分支；false 时须回到所属分支操作。" }),
  state: Type.Union([Type.Literal("starting"), Type.Literal("busy"), Type.Literal("idle"), Type.Literal("stopping"), Type.Literal("stopped"), Type.Literal("error")], { description: "进程状态；idle 不代表上轮工作成功，结果见 cycle.state。" }),
  activity: Type.String(), cycle: Type.Optional(cycle), error: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()), messageStatus: Type.Optional(Type.Literal("queued", { description: "消息已入队，不代表模型已阅读或完成。" })),
  cycles: Type.Optional(Type.Array(Type.Object({ cycleId: Type.String(), state: Type.String() }), { description: "仅 read 返回：可读取的周期索引。" })),
  report: Type.Optional(Type.String({ description: "仅 read 返回：选定周期的报告正文片段。已结束周期的读取结果持久化后领取该周期通知，即使本页未读完。" })),
  totalLength: Type.Optional(Type.Integer({ description: "仅 read 返回：完整报告的 UTF-16 字符数。" })),
  nextOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "仅 read 返回：null 表示本报告已读完；否则以相同 agentId、cycle.cycleId 和此 offset 继续。" })),
}, { additionalProperties: false });
export const agentResultSchema = Type.Union([agentViewSchema, Type.Object({ agents: Type.Array(agentViewSchema) }, { additionalProperties: false })]);
