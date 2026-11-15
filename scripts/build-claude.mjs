import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.claude.json"],
  { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const agentDirectory = resolve(root, "resources/claude/agents");
await mkdir(agentDirectory, { recursive: true });
const expert = await readFile(resolve(root, "resources/agents/general-purpose.md"), "utf8");
await writeFile(resolve(agentDirectory, "general-purpose.md"), [
  "---", "name: general-purpose", "description: 完成明确委派的分析、研究和项目任务，交回结果与产物。", "---", "", expert,
].join("\n"));
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
for (const file of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
  const path = resolve(root, file), manifest = JSON.parse(await readFile(path, "utf8"));
  if (file.endsWith("marketplace.json")) {
    for (const entry of manifest.plugins) { entry.version = version; if (entry.source.source === "npm") entry.source.version = version; }
  } else manifest.version = version;
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
}
