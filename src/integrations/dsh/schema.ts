import type { TSchema } from "typebox";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { requireThat } from "../../common/validation.js";

/** Remove TypeBox's non-JSON metadata before passing a schema to the native host. */
export function dshParameters(value: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Collaboration result unions are disjoint. rc.1 enforces structural oneOf schemas;
 * the producing tool also validates the complete contract, including these bounds. */
export function dshOutputSchema(value: TSchema): JsonSchemaNode {
  const bounds = new Set(["minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems"]);
  const supported = new Set(["type", "required", "additionalProperties", "enum", "const", "description", "title", "default", "examples"]);
  function convert(node: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (key === "anyOf") result.oneOf = (item as Record<string, unknown>[]).map(convert);
      else if (key === "properties") result.properties = Object.fromEntries(Object.entries(item as Record<string, Record<string, unknown>>).map(([name, child]) => [name, convert(child)]));
      else if (key === "items") result.items = convert(item as Record<string, unknown>);
      else if (!bounds.has(key)) { requireThat(supported.has(key), "dsh 输出 schema 不支持字段：" + key); result[key] = item; }
    }
    return result;
  }
  return convert(dshParameters(value)) as JsonSchemaNode;
}
