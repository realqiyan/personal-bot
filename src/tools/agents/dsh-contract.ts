import { Type } from "typebox";
import { agentActionSchema, agentParametersSchema, agentStartOptions } from "./contract.js";

const options = Type.Omit(Type.Object(agentStartOptions), ["provider", "model", "thinking", "files", "tools", "noExtensions", "noPromptTemplates", "noContextFiles", "noSkills"]).properties;
const native = {
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "dsh 原生 provider route，默认继承父会话。" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "该 dsh provider 的模型 ID，默认继承父会话。" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "该 dsh 模型的 reasoning effort ID，默认继承父会话。" })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "附给专家的文件；相对原工作区根目录。图片大小与格式遵循 dsh 限制。" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "能力工具名，不填写 run_code；省略时使用原生工具和 pbot_team_message。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "关闭该专家的技能目录和 skill 工具。" })),
};
const omitted = ["noExtensions", "noPromptTemplates", "noContextFiles", "provider", "model", "thinking", "files", "tools", "noSkills"] as const;
export const dshAgentParametersSchema = Type.Object({ ...Type.Omit(agentParametersSchema, omitted).properties, ...native }, { additionalProperties: false });
export const dshAgentActionSchema = Type.Union(agentActionSchema.anyOf.map(row => row.properties.action.const === "start"
  ? Type.Object({ action: Type.Literal("start"), ...options, ...native }, { additionalProperties: false }) : row));
