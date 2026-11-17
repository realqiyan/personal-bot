import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { ValidateFunction } from "ajv";
import { object } from "../common/json.js";
import { schemaDetail } from "../common/schema.js";
import { requireThat } from "../common/validation.js";

/** Optional tool field that also accepts null, the absence spelling of structured tool calls. */
export function nullable<T extends TSchema>(value: T) {
  return Type.Optional(Type.Union([value, Type.Null()]));
}

/** Validate one record shape, then treat null as absent before action-specific projection. */
export function inputObject(value: unknown, validate: ValidateFunction, label: string): Record<string, unknown> {
  requireThat(validate(value) && object(value), label + "：" + schemaDetail(validate));
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

/** A mode names each missing input instead of reporting a generic invalid-argument error. */
export function need<T>(action: string, args: Record<string, unknown>, key: string): T {
  const value = args[key];
  requireThat(value !== undefined, action + " 需要 " + key + "。");
  return value as T;
}

/** Copy only the fields a mode reads. Fields outside the projection never reach the service. */
export function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}
