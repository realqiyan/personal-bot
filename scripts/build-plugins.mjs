import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { compileProject, root } from "./compile-project.mjs";
import { build } from "esbuild";

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

async function copyLicenseAndDisclaimer(directory) {
  for (const file of ["LICENSE", "DISCLAIMER.md"]) {
    await cp(resolve(root, file), resolve(directory, file));
  }
}

/** Sync root Claude Code plugin and marketplace manifests. */
async function buildClaudePlugin({ version }) {
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
}

/** Assemble a self-contained Antigravity plugin bundle in lib/antigravity-plugin/. */
async function buildAntigravityPlugin({ version, repoUrl, runtime }) {
  const agyRoot = resolve(root, "lib/antigravity-plugin");
  await rm(agyRoot, { recursive: true, force: true });
  await mkdir(resolve(agyRoot, "skills"), { recursive: true });
  await mkdir(resolve(agyRoot, "resources/prompts"), { recursive: true });
  await copyLicenseAndDisclaimer(agyRoot);

  await cp(runtime, resolve(agyRoot, "lib"), { recursive: true });

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
    description: "Workspace materials, skills, and cross-harness MCP worker delegation.",
    ...(repoUrl ? { repository: repoUrl } : {}),
  }, null, 2) + "\n");

  await writeFile(resolve(agyRoot, "hooks.json"), JSON.stringify({
    "personal-bot": {
      SessionStart: [
        { type: "command", command: "node ./lib/plugin.js antigravity hook", timeout: 30 },
      ],
      PreToolUse: [
        {
          matcher: "read_file",
          hooks: [
            { type: "command", command: "node ./lib/plugin.js antigravity hook", timeout: 10 },
          ],
        },
      ],
      Stop: [
        { type: "command", command: "node ./lib/plugin.js antigravity hook", timeout: 10 },
      ],
    },
  }, null, 2) + "\n");

  await writeFile(resolve(agyRoot, "mcp_config.json"), JSON.stringify({
    mcpServers: {
      pbot: {
        command: "node",
        args: ["./lib/extension/mcp.js"],
        env: {
          PBOT_HOST: "antigravity",
        },
      },
    },
  }, null, 2) + "\n");

  for (const entry of await readdir(resolve(root, "resources/skills"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    await cp(resolve(root, "resources/skills", entry.name), resolve(agyRoot, "skills", entry.name), { recursive: true });
  }
  await cp(resolve(root, "resources/antigravity/skills"), resolve(agyRoot, "skills"), { recursive: true });

  await cp(resolve(root, "resources/agents"), resolve(agyRoot, "resources/agents"), { recursive: true });
  await cp(resolve(root, "resources/references"), resolve(agyRoot, "resources/references"), { recursive: true });
  await cp(resolve(root, "resources/templates"), resolve(agyRoot, "resources/templates"), { recursive: true });
  for (const prompt of ["workspace.md", "plugin-coordinator.md"]) {
    await cp(resolve(root, "resources/prompts", prompt), resolve(agyRoot, "resources/prompts", prompt));
  }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

// Native clients cache these manifests. The installed pbot executable owns the
// runtime and resources, including optional host bridges for delegated workers.
async function buildPromptPlugin(host, directory, version) {
  await rm(directory, { recursive: true, force: true });
  const manifestDir = resolve(directory, `.${host}-plugin`);
  const skillDir = resolve(directory, "skills/pbot");
  await mkdir(manifestDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await mkdir(resolve(directory, "hooks"), { recursive: true });
  await copyLicenseAndDisclaimer(directory);
  await writeJson(resolve(manifestDir, "plugin.json"), {
    name: "personal-bot", version, description: "Personal Bot workspace context and cross-harness workers.",
    skills: "./skills/", mcpServers: "./.mcp.json",
  });
  const command = { type: "command", command: `pbot plugin ${host} hook`, timeout: 30 };
  await writeJson(resolve(directory, "hooks/hooks.json"), {
    hooks: { SessionStart: [{ hooks: [command] }], UserPromptSubmit: [{ hooks: [command] }], Stop: [{ hooks: [command] }] },
  });
  await writeJson(resolve(directory, ".mcp.json"), {
    mcpServers: { pbot: { command: "pbot", args: ["mcp"], env: { PBOT_HOST: host } } },
  });
  const skill = await readFile(resolve(root, "resources/plugin/skills/pbot/SKILL.md"), "utf8");
  await writeFile(resolve(skillDir, "SKILL.md"), skill.replaceAll("<host>", host));
}

async function buildCodexPlugin({ version }) {
  const marketplace = resolve(root, "lib/codex-marketplace");
  const index = resolve(marketplace, ".agents/plugins");
  await mkdir(index, { recursive: true });
  const path = "./plugins/personal-bot";
  await buildPromptPlugin("codex", resolve(marketplace, path), version);
  const agents = resolve(marketplace, path, "skills/pbot/agents");
  await mkdir(agents, { recursive: true });
  await writeFile(resolve(agents, "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
  await writeJson(resolve(index, "marketplace.json"), {
    name: "pbot-local", plugins: [{ name: "personal-bot", source: { source: "local", path },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
  });
}

/** Extensible list of plugin host build targets. */
const pluginTargets = [
  { id: "codex", build: buildCodexPlugin },
  { id: "qoder", build: ({ version }) => buildPromptPlugin("qoder", resolve(root, "lib/qoder-plugin"), version) },
  { id: "claude", build: buildClaudePlugin },
  { id: "antigravity", build: buildAntigravityPlugin },
];

const { version, repository } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const repoUrl = typeof repository === "string"
  ? repository
  : typeof repository?.url === "string"
    ? repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
    : undefined;

// Both distributions receive the same isolated plugin runtime, without the optional host SDKs.
const runtime = await mkdtemp(resolve(tmpdir(), "pbot-plugin-runtime-"));
try {
  compileProject("tsconfig.claude.json", runtime);
  await bundleNode("src/mcp.ts", resolve(runtime, "extension/mcp.js"));
  await bundleNode("src/extension/acp/worker.ts", resolve(runtime, "extension/acp-worker.js"));
  await cp(runtime, resolve(root, "lib"), { recursive: true });
  for (const target of pluginTargets) {
    await target.build({ version, repoUrl, runtime });
  }
} finally {
  await rm(runtime, { recursive: true, force: true });
}
