import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkspaceConfig, readWorkspaceConfig, workspaceConfigPath } from "../../dist/services/workspace/workspace-config.js";

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

test("explicit init enables the workspace, preserves other fields and refuses malformed content", async t => {
  const root = await directory(t), path = workspaceConfigPath(root);
  await Promise.all([initializeWorkspaceConfig(root), initializeWorkspaceConfig(root)]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true });
  await writeFile(path, '{"enabled":false,"future":{"answer":42}}');
  await initializeWorkspaceConfig(root);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, future: { answer: 42 } });
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
    { enabled: true, acp: { codex: { args: ["--flag"] } } },
  ]) {
    await writeFile(path, JSON.stringify(bad));
    const parsed = await readWorkspaceConfig(root);
    assert.equal(parsed.enabled, false);
    assert.equal(typeof parsed.error, "string");
  }
});
