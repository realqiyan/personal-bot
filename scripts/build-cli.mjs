import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

await rm(new URL("../lib/", import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  "--project", "tsconfig.cli.json"], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
