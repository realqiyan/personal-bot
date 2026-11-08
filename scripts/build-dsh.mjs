import { spawnSync } from "node:child_process";
import { copyFile, glob, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  "--project", "tsconfig.dsh.json"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Pi supplies TypeBox through its loader; dsh needs a bundled copy without a package peer install.
const typebox = resolve(root, "lib/common/typebox.js");
await build({
  absWorkingDir: root, stdin: { contents: 'export * from "typebox";', resolveDir: root }, outfile: typebox,
  bundle: true, platform: "node", format: "esm", target: "es2022",
});
await copyFile(resolve(root, "node_modules/typebox/license"), resolve(root, "lib/common/typebox.LICENSE"));
for await (const file of glob("lib/**/*.js", { cwd: root })) {
  const path = resolve(root, file), source = await readFile(path, "utf8");
  if (!source.includes('from "typebox"')) continue;
  const specifier = relative(dirname(path), typebox).split(sep).join("/");
  await writeFile(path, source.replaceAll('from "typebox"', `from "${specifier.startsWith(".") ? specifier : `./${specifier}`}"`));
}

await build({
  absWorkingDir: root, entryPoints: ["src/ui/dsh/index.ts"], outfile: "lib/client.js",
  bundle: true, platform: "browser", format: "cjs", target: "es2022", packages: "external",
  banner: { js: 'window.__ModuleLoader__.load({ id: "personal-bot", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
