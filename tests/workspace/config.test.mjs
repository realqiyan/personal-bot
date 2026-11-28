import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkspaceConfig, readWorkspaceConfig, workspaceConfigPath, workspaceFeatures } from "../../dist/services/workspace/workspace-config.js";
import { readWorkspaceMcpConfig, resolveWorkspaceMcpServers, upsertWorkspaceMcpServer } from "../../dist/services/workspace/workspace-mcp.js";
import { discoverWorkspaceSkills } from "../../dist/services/workspace/workspace-skills.js";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("workspace activation requires an explicit boolean and never creates files while reading", async t => {
  const root = await directory(t), path = workspaceConfigPath(root);
  assert.deepEqual(await readWorkspaceConfig(root), { path, present: false, enabled: false });
  assert.deepEqual(await readdir(root), []);
  await mkdir(join(root, ".pbot"));
  for (const value of [{}, { enabled: false }, { enabled: true, future: { retained: 42 } }]) {
    await writeFile(path, JSON.stringify(value));
    const result = await readWorkspaceConfig(root);
    assert.equal(result.enabled, value.enabled === true);
    assert.equal(result.present, true);
    assert.equal(result.error, undefined);
  }
  for (const content of ["broken", "null", "[]", '{"enabled":"true"}', '{"enabled":1}']) {
    await writeFile(path, content);
    const result = await readWorkspaceConfig(root);
    assert.equal(result.enabled, false);
    assert.equal(result.present, true);
    assert.equal(typeof result.error, "string");
    assert.equal(await readFile(path, "utf8"), content);
  }
});

test("a parent workspace does not enable a nested workspace", async t => {
  const root = await directory(t), child = join(root, "projects", "child");
  await initializeWorkspaceConfig(root);
  await mkdir(child, { recursive: true });
  assert.equal((await readWorkspaceConfig(root)).enabled, true);
  assert.deepEqual(await readWorkspaceConfig(child), { path: workspaceConfigPath(child), present: false, enabled: false });
  assert.deepEqual(await readdir(child), []);
});

test("explicit init enables the workspace, writes explicit features defaults, preserves other fields and refuses malformed content", async t => {
  const root = await directory(t), path = workspaceConfigPath(root);
  const defaultFeatures = { prompts: true, skills: true, mcp: true, history: true };
  const defaultSummary = { backend: "pi", concurrency: 3 };
  await Promise.all([initializeWorkspaceConfig(root), initializeWorkspaceConfig(root)]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, features: defaultFeatures, summary: defaultSummary });
  await writeFile(path, '{"enabled":false,"future":{"answer":42}}');
  await initializeWorkspaceConfig(root);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, features: defaultFeatures, summary: defaultSummary, future: { answer: 42 } });
  await writeFile(path, '{"enabled":false,"features":{"prompts":false}}');
  await initializeWorkspaceConfig(root);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, features: { prompts: false, skills: true, mcp: true, history: true }, summary: defaultSummary });
  await writeFile(path, '{"enabled":true}');
  await initializeWorkspaceConfig(root);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, features: defaultFeatures, summary: defaultSummary });
  const invalid = "unreadable user configuration";
  await writeFile(path, invalid);
  await assert.rejects(initializeWorkspaceConfig(root));
  assert.equal(await readFile(path, "utf8"), invalid);
  await rm(path); await mkdir(path);
  const result = await readWorkspaceConfig(root);
  assert.equal(result.enabled, false); assert.equal(typeof result.error, "string");
});

test("workspace acp configuration supports permission policies and built-in overrides without repeating command", async t => {
  const root = await directory(t), path = workspaceConfigPath(root);
  await mkdir(join(root, ".pbot"));
  await writeFile(path, JSON.stringify({
    enabled: true,
    acp: {
      codex: { permission: "allow" },
      claude: { permission: "ask", env: { EXTRA: "1" } },
      custom: { command: process.execPath, permission: "deny" },
    },
  }));
  const valid = await readWorkspaceConfig(root);
  assert.equal(valid.enabled, true);
  assert.equal(valid.acp.codex.permission, "allow");
  assert.equal(valid.acp.claude.permission, "ask");
  assert.equal(valid.acp.custom.permission, "deny");
  for (const bad of [
    { enabled: true, acp: { codex: { permission: "invalid" } } },
    { enabled: true, acp: { codex: { permission: ["allow"] } } },
    { enabled: true, history: { layout: ["flat"] } },
    { enabled: true, acp: { codex: { args: ["--flag"] } } },
  ]) {
    await writeFile(path, JSON.stringify(bad));
    const parsed = await readWorkspaceConfig(root);
    assert.equal(parsed.enabled, false);
    assert.equal(typeof parsed.error, "string");
  }
});

test("workspace features toggles default to true, allow worker-only mode, and validate types", async t => {
  const root = await directory(t), path = workspaceConfigPath(root);
  await mkdir(join(root, ".pbot"));
  assert.deepEqual(workspaceFeatures(), { prompts: true, skills: true, mcp: true, history: true });
  await writeFile(path, JSON.stringify({ enabled: true, features: { prompts: false, skills: false, mcp: false, history: false } }));
  const parsed = await readWorkspaceConfig(root);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(workspaceFeatures(parsed), { prompts: false, skills: false, mcp: false, history: false });
  await writeFile(path, JSON.stringify({ enabled: true, features: { prompts: false } }));
  assert.deepEqual(workspaceFeatures(await readWorkspaceConfig(root)), { prompts: false, skills: true, mcp: true, history: true });
  for (const bad of [
    { enabled: true, features: "nope" },
    { enabled: true, features: { prompts: "yes" } },
    { enabled: true, features: { unknown: true } },
  ]) {
    await writeFile(path, JSON.stringify(bad));
    const result = await readWorkspaceConfig(root);
    assert.equal(result.enabled, false);
    assert.equal(typeof result.error, "string");
  }
});

test("workspace MCP config validates reserved names, env templates, and skills discovery parses YAML frontmatter", async t => {
  const root = await directory(t);
  assert.equal((await readWorkspaceMcpConfig(root)).present, false);
  await assert.rejects(upsertWorkspaceMcpServer(root, "pbot", { url: "https://example.test/mcp" }));
  await assert.rejects(upsertWorkspaceMcpServer(root, "both", { command: "node", url: "https://example.test/mcp" }));
  await upsertWorkspaceMcpServer(root, "demo", { command: "node", args: ["a.js"], env: { KEY: "${REQUIRED_KEY}" } });
  const cfg = await readWorkspaceMcpConfig(root);
  assert.throws(() => resolveWorkspaceMcpServers(root, cfg, {}), /REQUIRED_KEY/);
  const resolved = resolveWorkspaceMcpServers(root, cfg, { REQUIRED_KEY: "ok" });
  assert.equal(resolved[0].transport, "stdio");
  assert.equal(resolved[0].env.KEY, "ok");

  await mkdir(join(root, ".agents/skills/alpha"), { recursive: true });
  await mkdir(join(root, ".agents/skills/beta"), { recursive: true });
  await writeFile(join(root, ".agents/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: >-\n  Multi-line\n  description\n---\nBody\n");
  await writeFile(join(root, ".agents/skills/beta/SKILL.md"), '---\nname: "beta"\ndescription: "Single line"\n---\nBody\n');
  const skills = await discoverWorkspaceSkills(root);
  assert.deepEqual(skills, [
    { name: "alpha", description: "Multi-line description", path: ".agents/skills/alpha/SKILL.md" },
    { name: "beta", description: "Single line", path: ".agents/skills/beta/SKILL.md" },
  ]);
});

test("concurrent CLI edits preserve every independent workspace MCP server", async t => {
  const root = await directory(t);
  const configPath = join(root, ".pbot", "mcp.json");
  await mkdir(join(root, ".pbot"));
  const metadata = { owner: "workspace", notes: ["keep"] };
  await writeFile(configPath, JSON.stringify({ metadata, mcpServers: {} }));
  const names = Array.from({ length: 12 }, (_, i) => `service-${i}`);
  const cli = (...args) => promisify(execFile)(process.execPath, ["bin/pbot.mjs", "mcp", ...args]);
  await Promise.all(names.map(name => cli("add", name, "--workspace", root, "--", "node")));
  assert.deepEqual(Object.keys((await readWorkspaceMcpConfig(root)).servers).sort(), [...names].sort());
  await Promise.all(names.map(name => cli("remove", name, "--workspace", root)));
  assert.deepEqual((await readWorkspaceMcpConfig(root)).servers, {});
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { metadata, mcpServers: {} });
  assert.deepEqual(await readdir(join(root, ".pbot")), ["mcp.json"]);
});
