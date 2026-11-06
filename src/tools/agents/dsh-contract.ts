import { Type } from "typebox";
import { agentActionSchema, agentParametersSchema, agentStartOptions } from "./contract.js";

const options = Type.Omit(Type.Object(agentStartOptions), ["provider", "model", "thinking", "files", "tools", "noExtensions", "noPromptTemplates", "noContextFiles", "noSkills"]).properties;
const native = {
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "dsh 原生 provider route，默认继承父会话。" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "该 dsh provider 的模型 ID，默认继承父会话。" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "该 dsh 模型的原生 reasoning effort ID，默认继承父会话；不转换 Pi 思考等级。" })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "作为原生附件保存的文件；相对原工作区根目录。图片遵循宿主准入规则，其他文件保留原始字节供模型读取。" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "原生能力工具名；不填写 run_code 传输名，不支持递归委派。省略时使用原生工具和 pbot_team_message。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "关闭该专家的模型技能目录和原生 skill 工具；不改变其他会话的技能配置。" })),
};
const omitted = ["noExtensions", "noPromptTemplates", "noContextFiles", "provider", "model", "thinking", "files", "tools", "noSkills"] as const;
export const dshAgentParametersSchema = Type.Object({ ...Type.Omit(agentParametersSchema, omitted).properties, ...native }, { additionalProperties: false });
export const dshAgentActionSchema = Type.Union(agentActionSchema.anyOf.map(row => row.properties.action.const === "start"
  ? Type.Object({ action: Type.Literal("start"), ...options, ...native }, { additionalProperties: false }) : row));
