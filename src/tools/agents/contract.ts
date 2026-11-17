import { Type } from "typebox";
import type { AgentStartOptions } from "../../model/agent.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

export const agentDescription = "委派专家并继续对话。start 启动后即返回，完成自动通知，无需轮询；省略初始输入时待命。send 继续对话，团队占用期间不可私人 send。status 查看状态，read 读取报告；读取已结束周期即领取其通知，包括部分读取。续读固定 cycle.cycleId 并使用 nextOffset。state 表示执行状态，cycle.state 表示工作结果，queued 只表示入队。stop 保留历史，resume 携新 message 继续。每个父会话最多 50 个存活专家，空闲也计入。动作只读取自己的字段；其他已声明字段忽略。";

const id = Type.String({ minLength: 1, maxLength: 128 });
const message = Type.String({ minLength: 1, maxLength: 24000, description: "本次目标、相关资料、约束和交付要求。" });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$" });
const startFields = {
  backend: nullable(Type.Union([Type.Literal("pi"), Type.Literal("dsh"), Type.Literal("claude")], { description: "选择 ACP 子代理程序：pi、dsh 或 claude（Claude Code）。省略时使用当前宿主的原生专家；指定时使用目标程序自己的配置。" })),
  name: nullable(name), message: nullable(message),
  files: nullable(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "随初始消息读取的文件；相对路径基于原工作区根目录。" })),
  provider: nullable(Type.String({ ...id, description: "模型提供方覆盖项；省略时继承主会话或使用 ACP 目标配置。指定时须同时指定 model。" })),
  model: nullable(Type.String({ ...id, description: "模型 ID 覆盖项；省略时继承主会话或使用 ACP 目标配置。Pi/dsh 同名模型可用 provider 区分。" })),
  thinking: nullable(Type.String({ minLength: 1, maxLength: 128, description: "思考等级覆盖项；省略时继承主会话或使用 ACP 目标配置。Pi 使用 off/minimal/low/medium/high/xhigh/max，其他程序使用其原生等级 ID。" })),
  cwd: nullable(Type.String({ minLength: 1, description: "执行目录，相对原工作区根目录；省略时使用工作区根目录。" })),
  tools: nullable(Type.Array(id, { minItems: 1, description: "Pi/dsh 子代理的工具名；省略时使用所选程序默认工具。Claude 子代理忽略此项并沿用原生配置。" })),
  noExtensions: nullable(Type.Boolean({ description: "仅用于 Pi 子代理：关闭其他扩展的自动发现，默认 true。" })),
  noSkills: nullable(Type.Boolean({ description: "Pi/dsh 子代理关闭技能发现，默认 false；Claude 子代理忽略此项并沿用原生配置。" })),
  noPromptTemplates: nullable(Type.Boolean({ description: "仅用于 Pi 子代理：关闭提示模板发现，默认 false。" })),
  noContextFiles: nullable(Type.Boolean({ description: "仅用于 Pi 子代理：关闭原生上下文文件加载，默认 false。" })),
} as const;
export const agentParametersSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("rename"), Type.Literal("status"), Type.Literal("list"), Type.Literal("read"), Type.Literal("stop"), Type.Literal("resume")], {
    description: "start 创建专家；省略 message/files 即待命。send 必填 agentId/message，可选 delivery。resume 必填 agentId/message。stop/status 必填 agentId。rename 必填 agentId/name。read 必填 agentId，可选 cycleId/offset/limit。list 只需 action。动作只读取自己的字段；其他已声明字段忽略。",
  }),
  agentId: nullable(id), ...startFields,
  cycleId: nullable(Type.String({ ...id, description: "仅 read：省略时读取最近周期；按 nextOffset 续读时须固定为上页返回的 cycle.cycleId，避免切换到新周期。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "仅 read：报告正文的 UTF-16 字符偏移，默认 0；续读使用上页 nextOffset。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：最多返回的正文 UTF-16 字符数，默认 16000，不是消息数或 token 数。" })),
  delivery: nullable(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "仅 send：默认 steer 补充当前工作；followUp 排到当前工作之后。capabilities.steer 为 false 的成员运行中使用 followUp。" })),
}, { additionalProperties: false });

export type AgentAction = "start" | "send" | "rename" | "status" | "list" | "read" | "stop" | "resume";
export type AgentInput =
  | ({ action: "start" } & AgentStartOptions)
  | { action: "send"; agentId: string; message: string; delivery?: "steer" | "followUp" }
  | { action: "resume"; agentId: string; message: string }
  | { action: "rename"; agentId: string; name: string }
  | { action: "stop" | "status"; agentId: string }
  | { action: "list" }
  | { action: "read"; agentId: string; cycleId?: string; offset?: number; limit?: number };

const startKeys = Object.keys(startFields);
const valid = schema(agentParametersSchema);

/** One flat record, one interpreter. Fields outside the selected action are inert. */
export function agentInput(value: unknown): AgentInput {
  const args = inputObject(value, valid, "专家参数格式无效");
  const action = args.action as AgentAction;
  switch (action) {
    case "start":
      requireThat(!args.provider || args.model !== undefined, "start 需要同时提供 provider 与 model。");
      return { action, ...(pick(args, startKeys) as AgentStartOptions) };
    case "send":
      return { action, agentId: need("send", args, "agentId"), message: need("send", args, "message"),
        ...(args.delivery === undefined ? {} : { delivery: args.delivery as "steer" | "followUp" }) };
    case "resume":
      return { action, agentId: need("resume", args, "agentId"), message: need("resume", args, "message") };
    case "rename":
      return { action, agentId: need("rename", args, "agentId"), name: need("rename", args, "name") };
    case "stop":
    case "status":
      return { action, agentId: need(action, args, "agentId") };
    case "list":
      return { action };
    case "read":
      return { action, agentId: need("read", args, "agentId"),
        ...(args.cycleId === undefined ? {} : { cycleId: args.cycleId as string }),
        ...(args.offset === undefined ? {} : { offset: args.offset as number }),
        ...(args.limit === undefined ? {} : { limit: args.limit as number }) };
    default:
      throw new Error("未知的专家 action。");
  }
}

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
    { additionalProperties: false, description: "子代理实际模型配置与有效思考等级，包含默认值。" })),
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
