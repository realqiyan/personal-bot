import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directories, prepareWorkspace } from "../../dist/services/workspace/workspace-preparation.js";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("optional preparation creates documents without state and preserves existing files on repeat", async t => {
  const root = await directory(t);
  await prepareWorkspace(root);
  assert.deepEqual((await readdir(root)).sort(), [...directories, "AGENTS.md"].sort());
  await writeFile(join(root, "AGENTS.md"), "User instructions");
  await writeFile(join(root, "projects/research.txt"), "Evidence");
  await prepareWorkspace(root);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "User instructions");
  assert.equal(await readFile(join(root, "projects/research.txt"), "utf8"), "Evidence");
});

test("preparation ignores and preserves legacy state and history", async t => {
  const root = await directory(t), internal = join(root, ".legacy");
  await mkdir(internal);
  const records = Buffer.from([0, 255, 17, 42]);
  await writeFile(join(internal, "workspace.json"), "unreadable old state");
  await writeFile(join(internal, "records.bin"), records);
  await prepareWorkspace(root);
  assert.equal(await readFile(join(internal, "workspace.json"), "utf8"), "unreadable old state");
  assert.deepEqual(await readFile(join(internal, "records.bin")), records);
  assert.deepEqual((await readdir(internal)).sort(), ["records.bin", "workspace.json"]);
});

test("preparation does not follow directory aliases or overwrite an existing AGENTS alias", async t => {
  const root = await directory(t), outside = await directory(t);
  await symlink(outside, join(root, "areas"));
  await assert.rejects(prepareWorkspace(root));
  assert.deepEqual(await readdir(outside), []);
  await rm(join(root, "areas"));
  await writeFile(join(outside, "AGENTS.md"), "External instructions");
  await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
  await prepareWorkspace(root);
  assert.equal(await readFile(join(outside, "AGENTS.md"), "utf8"), "External instructions");
});
