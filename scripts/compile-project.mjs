import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

export function compileProject(project, outDir) {
  const args = [resolve(root, "node_modules/typescript/bin/tsc"), "--project", project];
  if (outDir) args.push("--outDir", outDir);
  execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
}
