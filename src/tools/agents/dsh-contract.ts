import { Type } from "typebox";
import { agentActionSchema, agentParametersSchema, agentStartOptions } from "./contract.js";

const options = Type.Omit(Type.Object(agentStartOptions), ["provider", "model", "thinking", "files", "tools", "noExtensions", "noPromptTemplates", "noContextFiles", "noSkills"]).properties;
const native = {
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "dsh 原生 provider route，默认继承父会话。" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "可选模型 ID；原生专家继承父会话，ACP 支持目标原生模型 ID，省略时使用目标默认模型。" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "可选 reasoning effort ID；ACP 省略时使用目标默认等级，也可仅指定 thinking。" })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "附给专家的文件；相对原工作区根目录。图片大小与格式遵循 dsh 限制。" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "能力工具名，不填写 run_code；省略时使用原生工具和 pbot_team_message。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "Pi/dsh 目标关闭技能发现与 skill 工具；Claude 使用其原生配置。" })),
};
const omitted = ["noExtensions", "noPromptTemplates", "noContextFiles", "provider", "model", "thinking", "files", "tools", "noSkills"] as const;
export const dshAgentParametersSchema = Type.Object({ ...Type.Omit(agentParametersSchema, omitted).properties, ...native,
  noExtensions: agentStartOptions.noExtensions, noPromptTemplates: agentStartOptions.noPromptTemplates, noContextFiles: agentStartOptions.noContextFiles,
}, { additionalProperties: false });
export const dshAgentActionSchema = Type.Union(agentActionSchema.anyOf.map(row => row.properties.action.const === "start"
  ? Type.Object({ action: Type.Literal("start"), ...options, ...native,
    noExtensions: agentStartOptions.noExtensions, noPromptTemplates: agentStartOptions.noPromptTemplates, noContextFiles: agentStartOptions.noContextFiles,
  }, { additionalProperties: false }) : row));
