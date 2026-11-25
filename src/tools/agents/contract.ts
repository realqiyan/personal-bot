import { Type } from "typebox";
import type { AgentStartOptions } from "../../model/agent.js";
import { requireThat } from "../../common/validation.js";
import { schema } from "../../common/schema.js";
import { inputObject, need, nullable, pick } from "../input.js";

export const agentDescription = "委派专家并继续对话。start 启动后立即返回，完成自动通知，无需轮询；省略 message/files 时待命。send 继续对话（团队占用期间不可私人 send）。status 查状态，read 读报告（读取已结束周期即领取通知，含部分读取；续读固定 cycle.cycleId 并传 nextOffset）。state 是执行状态，工作结果看 cycle.state；queued 仅表示入队。stop 保留历史，resume 携新 message 继续。原生专家省略 capabilities；ACP 专家不可加入团队。每个父会话最多 50 个存活专家（含空闲）。";

const id = Type.String({ minLength: 1, maxLength: 128 });
const message = Type.String({ minLength: 1, maxLength: 24000, description: "start 可选、send/resume 必填：任务目标、相关资料、约束和交付要求。" });
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\r\\n\\x00-\\x1f]+$", description: "start 可选显示名；rename 必填新名称。" });
const startFields = {
  backend: nullable(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "仅 start：选择 ACP 目标程序（内置 pi、dsh、claude、antigravity、codex，或 .pbot/config.json 中自定义的 ACP 名称）；省略时使用当前宿主原生专家。ACP 专家使用目标程序配置且不可加入团队。" })),
  name: nullable(name), message: nullable(message),
  files: nullable(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "仅 start：随初始消息附带的文件，相对路径基于原工作区根目录。" })),
  provider: nullable(Type.String({ ...id, description: "仅 start：模型提供方覆盖项，须同时指定 model（Claude ACP 忽略此项）。省略时原生专家继承主会话，ACP 使用目标默认配置。" })),
  model: nullable(Type.String({ ...id, description: "仅 start：模型 ID 覆盖项；省略时原生专家继承主会话，ACP 使用目标默认配置。Pi/dsh 同名模型可用 provider 区分。" })),
  thinking: nullable(Type.String({ minLength: 1, maxLength: 128, description: "仅 start：思考等级覆盖项；省略时继承主会话或使用 ACP 目标配置。Pi 使用 off/minimal/low/medium/high/xhigh/max，其他程序用各自原生等级 ID。" })),
  cwd: nullable(Type.String({ minLength: 1, description: "仅 start：执行目录，相对原工作区根目录；省略时使用工作区根目录。" })),
  tools: nullable(Type.Array(id, { minItems: 1, description: "仅 start：允许的工具名列表；仅用于当前宿主原生专家及 Pi ACP，dsh/Claude ACP 忽略此项。" })),
  noExtensions: nullable(Type.Boolean({ description: "仅 start（Pi 专家）：关闭其他扩展自动发现，默认 true。" })),
  noSkills: nullable(Type.Boolean({ description: "仅 start：关闭技能发现，默认 false；仅用于当前宿主原生专家及 Pi ACP，dsh/Claude ACP 忽略此项。" })),
  noPromptTemplates: nullable(Type.Boolean({ description: "仅 start（Pi 专家）：关闭提示模板发现，默认 false。" })),
  noContextFiles: nullable(Type.Boolean({ description: "仅 start（Pi 专家）：关闭原生上下文文件加载，默认 false。" })),
} as const;
export const agentParametersSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("rename"), Type.Literal("status"), Type.Literal("list"), Type.Literal("read"), Type.Literal("stop"), Type.Literal("resume")], {
    description: "start 创建专家；send 必填 agentId/message（可选 delivery）；resume 必填 agentId/message；stop/status 必填 agentId；rename 必填 agentId/name；read 必填 agentId（可选 cycleId/offset/limit）；list 只需 action。各动作仅读取自身字段，其余字段忽略。",
  }),
  agentId: nullable(Type.String({ ...id, description: "send/resume/rename/status/read/stop 必填：专家 ID。" })), ...startFields,
  cycleId: nullable(Type.String({ ...id, description: "仅 read：省略时读最近周期；按 nextOffset 续读时固定为上页返回的 cycle.cycleId。" })),
  offset: nullable(Type.Integer({ minimum: 0, description: "仅 read：报告正文字符偏移，默认 0；续读直接传上页 nextOffset。" })),
  limit: nullable(Type.Integer({ minimum: 1, maximum: 16000, description: "仅 read：最多返回的正文字符数，默认 16000。" })),
  delivery: nullable(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { description: "仅 send：默认 steer 补充当前工作；followUp 排到当前工作之后。ACP 专家运行中（capabilities.steer 为 false）请用 followUp。" })),
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
  backend: Type.Optional(Type.String()),
  transport: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("acp")])),
  selection: Type.Optional(Type.Object({ provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
    resolvedModel: Type.Optional(Type.String({ description: "目标原生会话报告的模型 ID，可用于识别配置别名。" })), thinking: Type.Optional(Type.String()) },
    { additionalProperties: false, description: "子代理实际模型配置与有效思考等级，包含默认值。" })),
  capabilities: Type.Optional(Type.Object({
    steer: Type.Boolean({ description: "运行中是否支持 steer 插话。" }),
    resume: Type.Boolean({ description: "停止后是否支持 resume 恢复。" }),
    team: Type.Boolean({ description: "是否可加入 pbot_team。" }),
    transcript: Type.Boolean(),
  }, { additionalProperties: false, description: "仅 ACP 专家返回；原生专家省略此字段且默认支持全部能力。" })),
  owned: Type.Boolean({ description: "是否属于当前父会话分支；false 时须回到所属分支操作。" }),
  state: Type.Union([Type.Literal("starting"), Type.Literal("busy"), Type.Literal("idle"), Type.Literal("stopping"), Type.Literal("stopped"), Type.Literal("error")], { description: "执行状态；idle 不代表上轮工作成功，结果见 cycle.state。" }),
  activity: Type.String(), cycle: Type.Optional(cycle), error: Type.Optional(Type.String()),
  requestId: Type.Optional(Type.String()), messageStatus: Type.Optional(Type.Literal("queued", { description: "消息已入队，不代表模型已阅读或完成。" })),
  cycles: Type.Optional(Type.Array(Type.Object({ cycleId: Type.String(), state: Type.String() }), { description: "仅 read 返回：可读取的周期索引。" })),
  report: Type.Optional(Type.String({ description: "仅 read 返回：选定周期的报告正文片段。" })),
  totalLength: Type.Optional(Type.Integer({ description: "仅 read 返回：完整报告字符数。" })),
  nextOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "仅 read 返回：null 表示已读完；否则以相同 agentId、cycle.cycleId 和此 offset 续读。" })),
}, { additionalProperties: false });
export const agentResultSchema = Type.Union([agentViewSchema, Type.Object({ agents: Type.Array(agentViewSchema) }, { additionalProperties: false })]);
