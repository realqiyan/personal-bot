import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { object } from "./json.js";

export function schema(value: unknown): ValidateFunction {
  if (!object(value)) throw new Error("需要对象形式的 JSON Schema。");
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats.default(ajv);
  return ajv.compile(value);
}

/** Name the concrete shape violation so the caller can correct the same field. */
export function schemaDetail(validate: ValidateFunction): string {
  return (validate.errors ?? []).map(error => {
    const params = error.params as Record<string, unknown>;
    const field = typeof params.additionalProperty === "string" ? params.additionalProperty
      : error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : "参数";
    return field + " " + (error.message ?? "不符合 schema");
  }).join("；") || "不符合 schema";
}
