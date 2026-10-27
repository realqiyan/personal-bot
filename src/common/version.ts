import { readFileSync } from "node:fs";
import { object } from "./json.js";
import { requireThat } from "./validation.js";

/** Before 1.0, the minor release defines compatibility; afterwards, the major does. */
export function releaseLine(version: string): string {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  requireThat(parts, "pbot 发布版本必须使用 MAJOR.MINOR.PATCH。");
  return parts[1] === "0" ? `0.${parts[2]}` : parts[1]!;
}

const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
requireThat(object(manifest) && typeof manifest.version === "string", "pbot 包缺少发布版本。");
export const packageVersion = manifest.version;
releaseLine(packageVersion);
