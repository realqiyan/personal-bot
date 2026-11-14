import { Type } from "typebox";
import { agentActionSchema, agentParametersSchema, agentStartOptions } from "./contract.js";

const options = Type.Omit(Type.Object(agentStartOptions), ["provider", "model", "thinking", "files", "tools", "noExtensions", "noPromptTemplates", "noContextFiles", "noSkills"]).properties;
const native = {
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "模型提供方，dsh 使用原生 provider route。省略 backend 时默认继承主会话；指定 backend 时，此参数须与 model 一起提供。Claude 子代理省略此参数。" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "模型 ID；指定 backend 时也可使用目标公开的完整模型值。默认值：省略 backend 时继承主会话，指定时使用目标配置。" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "思考等级 ID，dsh 使用原生 reasoning effort，可单独指定。默认值：省略 backend 时继承主会话，指定时使用目标配置。" })),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: "附给子代理的文件；相对原工作区根目录。图片格式与大小遵循所选程序的支持范围。" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "dsh 子代理填 run_code 内的能力工具名，Pi 子代理填 Pi 工具名。省略时使用所选程序默认工具；未指定 backend 的专家另有 pbot_team_message。Claude 子代理省略此参数并沿用原生配置。" })),
  noSkills: Type.Optional(Type.Boolean({ description: "Pi/dsh 子代理关闭技能发现，默认 false；dsh 同时关闭 skill 工具。Claude 子代理省略此参数并沿用原生配置。" })),
};
const omitted = ["noExtensions", "noPromptTemplates", "noContextFiles", "provider", "model", "thinking", "files", "tools", "noSkills"] as const;
export const dshAgentParametersSchema = Type.Object({ ...Type.Omit(agentParametersSchema, omitted).properties, ...native,
  noExtensions: agentStartOptions.noExtensions, noPromptTemplates: agentStartOptions.noPromptTemplates, noContextFiles: agentStartOptions.noContextFiles,
}, { additionalProperties: false });
export const dshAgentActionSchema = Type.Union(agentActionSchema.anyOf.map(row => row.properties.action.const === "start"
  ? Type.Object({ action: Type.Literal("start"), ...options, ...native,
    noExtensions: agentStartOptions.noExtensions, noPromptTemplates: agentStartOptions.noPromptTemplates, noContextFiles: agentStartOptions.noContextFiles,
  }, { additionalProperties: false }) : row));
