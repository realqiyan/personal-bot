import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const tsc = resolve(root, "node_modules/typescript/bin/tsc");

function compile(args) {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function bundleNode(entryPoint, outfile) {
  await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
}

// 1. Compile shared plugin runtime + Claude compatibility entry into lib/
compile(["--project", "tsconfig.claude.json"]);

// 2. Bundle standalone cross-harness MCP server and ACP worker (no node_modules needed in plugin caches)
await bundleNode("src/mcp.ts", resolve(root, "lib/extension/mcp.js"));
await bundleNode("src/extension/acp-worker.ts", resolve(root, "lib/extension/acp-worker.js"));

const { version, repository } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const expert = await readFile(resolve(root, "resources/agents/general-purpose.md"), "utf8");
const agentDocument = [
  "---",
  "name: general-purpose",
  "description: 完成明确委派的分析、研究和项目任务，交回结果与产物。",
  "---",
  "",
  expert,
].join("\n");

// 3. Generate Claude native agent and sync Claude plugin & marketplace manifests
const claudeAgents = resolve(root, "resources/claude/agents");
await mkdir(claudeAgents, { recursive: true });
await writeFile(resolve(claudeAgents, "general-purpose.md"), agentDocument);

for (const file of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
  const path = resolve(root, file);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (file.endsWith("marketplace.json")) {
    for (const entry of manifest.plugins) {
      entry.version = version;
      if (entry.source.source === "npm") entry.source.version = version;
    }
  } else {
    manifest.version = version;
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
}

// 4. Build self-contained Antigravity plugin bundle in lib/antigravity-plugin/
const agyRoot = resolve(root, "lib/antigravity-plugin");
await rm(agyRoot, { recursive: true, force: true });
await mkdir(resolve(agyRoot, "agents"), { recursive: true });
await mkdir(resolve(agyRoot, "skills"), { recursive: true });
await mkdir(resolve(agyRoot, "resources/prompts"), { recursive: true });
await mkdir(resolve(agyRoot, "lib/extension"), { recursive: true });

compile(["--project", "tsconfig.claude.json", "--outDir", resolve(agyRoot, "lib")]);
await cp(resolve(root, "lib/extension/mcp.js"), resolve(agyRoot, "lib/extension/mcp.js"));
await cp(resolve(root, "lib/extension/acp-worker.js"), resolve(agyRoot, "lib/extension/acp-worker.js"));

const repoUrl = typeof repository === "string"
  ? repository
  : typeof repository?.url === "string"
    ? repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
    : undefined;

await writeFile(resolve(agyRoot, "package.json"), JSON.stringify({
  name: "personal-bot-antigravity-plugin",
  version,
  type: "module",
  private: true,
}, null, 2) + "\n");

await writeFile(resolve(agyRoot, "plugin.json"), JSON.stringify({
  name: "personal-bot",
  displayName: "Personal Bot",
  version,
  description: "Workspace materials, skills, native experts, and cross-harness ACP delegation.",
  ...(repoUrl ? { repository: repoUrl } : {}),
}, null, 2) + "\n");

await writeFile(resolve(agyRoot, "hooks.json"), JSON.stringify({
  "personal-bot": {
    SessionStart: [
      { type: "command", command: "node ./lib/plugin.js antigravity hook", timeout: 30 },
    ],
    PreToolUse: [
      {
        matcher: "read_file|invoke_subagent",
        hooks: [
          { type: "command", command: "node ./lib/plugin.js antigravity hook", timeout: 10 },
        ],
      },
    ],
  },
}, null, 2) + "\n");

await writeFile(resolve(agyRoot, "mcp_config.json"), JSON.stringify({
  mcpServers: {
    "personal-bot-agents": {
      command: "node",
      args: ["./lib/extension/mcp.js"],
    },
  },
}, null, 2) + "\n");

await writeFile(resolve(agyRoot, "agents/general-purpose.md"), agentDocument);

for (const entry of await readdir(resolve(root, "resources/skills"), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  await cp(resolve(root, "resources/skills", entry.name), resolve(agyRoot, "skills", entry.name), { recursive: true });
}
await cp(resolve(root, "resources/antigravity/skills"), resolve(agyRoot, "skills"), { recursive: true });

await cp(resolve(root, "resources/agents"), resolve(agyRoot, "resources/agents"), { recursive: true });
await cp(resolve(root, "resources/references"), resolve(agyRoot, "resources/references"), { recursive: true });
await cp(resolve(root, "resources/templates"), resolve(agyRoot, "resources/templates"), { recursive: true });
for (const prompt of ["workspace.md", "antigravity-coordinator.md"]) {
  await cp(resolve(root, "resources/prompts", prompt), resolve(agyRoot, "resources/prompts", prompt));
}
