import { Type } from "typebox";

export const agentDescription = "委派专家并继续对话。start 启动后即返回，完成自动通知，无需轮询；省略初始输入时待命。send 继续对话，团队占用期间不可私人 send。status 查看状态，read 读取报告；读取已结束周期即领取其通知，包括部分读取。续读固定 cycle.cycleId 并使用 nextOffset。state 表示执行状态，cycle.state 表示工作结果，queued 只表示入队。stop 保留历史，resume 携新 message 继续。每个父会话最多 50 个存活专家，空闲也计入。";

const id = Type.String({ minLength: 1, maxLength: 128 });
const message = Type.String({ minLength: 1, maxLength: 24000, description: "本次目标、相关资料、约束和交付要求。" });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
export const agentStartOptions = {
  backend: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")], { description: "通过 ACP 调用目标宿主；省略时使用当前宿主原生专家。ACP 模型和认证使用目标配置。" })),
  name: Type.Optional(name), message: Type.Optional(message),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "随初始消息读取的文件；相对路径基于原工作区根目录。" })),
  prompts: Type.Optional(Type.Array(message, { maxItems: 32, description: "与 message 按顺序合并为同一初始消息。" })),
  provider: Type.Optional(Type.String({ ...id, description: "模型提供方；原生专家默认继承主会话，ACP 使用目标宿主配置。" })),
  model: Type.Optional(Type.String({ ...id, description: "可选模型 ID。ACP 支持原生模型 ID 或完整模型值，省略时使用目标宿主默认模型；重名时可指定 provider。" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "可选思考等级 ID；ACP 省略时使用目标宿主默认等级，也可仅指定 thinking。Pi 使用 off/minimal/low/medium/high/xhigh/max，其他目标使用其原生等级 ID。" })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "执行目录，相对原工作区根目录；省略时使用工作区根目录。" })),
  tools: Type.Optional(Type.Array(id, { minItems: 1, description: "原生及 Pi/dsh 目标的工具名；省略时使用目标默认工具。Claude 通过其原生配置选择。" })),
  noExtensions: Type.Optional(Type.Boolean({ description: "Pi 专属，默认 true，不发现其他扩展。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "Pi/dsh 目标关闭技能发现，默认 false；Claude 使用其原生配置。" })),
  noPromptTemplates: Type.Optional(Type.Boolean({ description: "关闭提示模板发现，默认 false。" })),
  noContextFiles: Type.Optional(Type.Boolean({ description: "关闭 Pi 原生上下文文件加载，默认 false。" })),
};
const page = {
  cycleId: Type.Optional(Type.String({ ...id, description: "仅 read：省略时读取最近周期；按 nextOffset 续读时须固定为上页返回的 cycle.cycleId，避免切换到新周期。" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "仅 read：报告正文的 UTF-16 字符偏移，默认 0；续读使用上页 nextOffset。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：最多返回的正文 UTF-16 字符数，默认 16000，不是消息数或 token 数。" })),
};
const delivery = Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "send 默认 steer 补充当前工作；followUp 排到当前工作之后。ACP 成员运行中使用 followUp。" }));
export const agentParametersSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("rename"), Type.Literal("status"), Type.Literal("list"), Type.Literal("read"), Type.Literal("stop"), Type.Literal("resume")], {
    description: "start 仅接受启动选项，可省略 message/prompts/files 创建待命会话，禁止 agentId/delivery/分页字段；list 只接受 action；status/stop 只接受并必填 agentId；send 必填 agentId/message，仅可选 delivery；resume 必填 agentId/message；rename 必填 agentId/name；read 必填 agentId，仅可选 cycleId/offset/limit。禁止携带其他 action 的字段。",
  }),
  agentId: Type.Optional(id), ...agentStartOptions, ...page, delivery,
}, { additionalProperties: false });
export const agentActionSchema = Type.Union([
  Type.Object({ action: Type.Literal("start"), ...agentStartOptions }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("send"), agentId: id, message, delivery }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("rename"), agentId: id, name }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume"), agentId: id, message }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  ...["stop", "status"].map(action => Type.Object({ action: Type.Literal(action), agentId: id }, { additionalProperties: false })),
  Type.Object({ action: Type.Literal("read"), agentId: id, ...page }, { additionalProperties: false }),
]);

const cycle = Type.Object({ cycleId: Type.String(), startedAt: Type.Number(), finishedAt: Type.Optional(Type.Number()),
  state: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")], { description: "本周期的工作结果，正文用 read 读取。" }),
  requestIds: Type.Array(Type.String()),
  source: Type.Union([Type.Literal("parent"), Type.Literal("interactive"), Type.Literal("mixed")]), error: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const agentViewSchema = Type.Object({ agentId: Type.String(), name: Type.String(), cwd: Type.String(), createdAt: Type.Number(),
  backend: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")])),
  transport: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("acp")])),
  selection: Type.Optional(Type.Object({ provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
    resolvedModel: Type.Optional(Type.String({ description: "目标原生会话报告的模型 ID，可用于识别配置别名。" })), thinking: Type.Optional(Type.String()) },
    { additionalProperties: false, description: "ACP 模型配置与有效思考等级，包含宿主默认值。" })),
  capabilities: Type.Optional(Type.Object({ steer: Type.Boolean(), resume: Type.Boolean(), team: Type.Boolean(), transcript: Type.Boolean() }, { additionalProperties: false })),
  owned: Type.Boolean({ description: "是否属于当前父会话分支；false 时须回到所属分支操作。" }),
  state: Type.Union([Type.Literal("starting"), Type.Literal("busy"), Type.Literal("idle"), Type.Literal("stopping"), Type.Literal("stopped"), Type.Literal("error")], { description: "执行状态；idle 不代表上轮工作成功，结果见 cycle.state。" }),
  activity: Type.String(), cycle: Type.Optional(cycle), error: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()), messageStatus: Type.Optional(Type.Literal("queued", { description: "消息已入队，不代表模型已阅读或完成。" })),
  cycles: Type.Optional(Type.Array(Type.Object({ cycleId: Type.String(), state: Type.String() }), { description: "仅 read 返回：可读取的周期索引。" })),
  report: Type.Optional(Type.String({ description: "仅 read 返回：选定周期的报告正文片段。" })),
  totalLength: Type.Optional(Type.Integer({ description: "仅 read 返回：完整报告的 UTF-16 字符数。" })),
  nextOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "仅 read 返回：null 表示本报告已读完；否则以相同 agentId、cycle.cycleId 和此 offset 继续。" })),
}, { additionalProperties: false });
export const agentResultSchema = Type.Union([agentViewSchema, Type.Object({ agents: Type.Array(agentViewSchema) }, { additionalProperties: false })]);
