import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  "--project", "tsconfig.dsh.json"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await build({
  absWorkingDir: root, entryPoints: ["src/ui/dsh/index.ts"], outfile: "lib/client.js",
  bundle: true, platform: "browser", format: "cjs", target: "es2022", packages: "external",
  banner: { js: 'window.__ModuleLoader__.load({ id: "personal-bot", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
