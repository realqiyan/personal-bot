import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot, rpcWorkspace } from "../helpers/pi-rpc.mjs";

const exec = promisify(execFile);

test("smoke: loading the source package enables Personal Bot without creating workspace files", { timeout: 30_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  const pi = await workspace.start();
  const { commands } = await pi.request("get_commands");
  assert.ok(commands.some(command => command.name === "pbot"));
  const resources = await pi.inspect();
  assert.deepEqual(resources.tools.filter(name => name.startsWith("pbot_")).sort(), ["pbot_agent"]);
  assert.ok(resources.skills.length > 0);
  await pi.command("/pbot status");
  await pi.command("/pbot upgrade");
  assert.deepEqual(await readdir(workspace.root), []);
  assert.ok(!pi.records.some(record => record.type === "extension_error"));
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

test("smoke: obsolete state cannot block Personal Bot and preparation preserves historical files", { timeout: 30_000 }, async t => {
  const workspace = await rpcWorkspace(t), internal = join(workspace.root, ".legacy");
  await mkdir(internal);
  const value = JSON.stringify({ format: "legacy/1", status: "pending" });
  const records = Buffer.from([0, 255, 17, 42]);
  await writeFile(join(internal, "workspace.json"), value);
  await writeFile(join(internal, "records.bin"), records);
  const pi = await workspace.start();
  assert.deepEqual((await pi.inspect()).tools.filter(name => name.startsWith("pbot_")).sort(), ["pbot_agent"]);
  await pi.command("/pbot upgrade");
  await pi.command("/pbot init");
  assert.equal(await readFile(join(internal, "workspace.json"), "utf8"), value);
  assert.deepEqual(await readFile(join(internal, "records.bin")), records);
  assert.deepEqual((await readdir(internal)).sort(), ["records.bin", "workspace.json"]);
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});

test("smoke: packed sources load tools and the standalone setup script without dist or initialization", { timeout: 60_000 }, async t => {
  const workspace = await rpcWorkspace(t);
  const { temp } = workspace;
  const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", temp], {
    cwd: packageRoot, timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: temp, LANG: "C.UTF-8", npm_config_cache: join(temp, "cache") },
  });
  const [{ filename }] = JSON.parse(stdout);
  await exec("tar", ["-xzf", join(temp, filename), "-C", temp], { timeout: 10_000 });
  const packed = join(temp, "package");
  const plan = await exec("/usr/bin/python3", ["-I", "-B", join(packed, "scripts/setup-python.py"), "--check"],
    { env: { HOME: temp, XDG_DATA_HOME: join(temp, "empty-data") } });
  assert.equal(JSON.parse(plan.stdout).python, join(temp, "empty-data/pbot/python/.venv/bin/python"));
  await assert.rejects(readdir(join(temp, "empty-data")), { code: "ENOENT" });
  assert.deepEqual(await readdir(workspace.root), []);
  // Supply the already installed locked dependencies; do not download or install packages.
  await symlink(join(packageRoot, "node_modules"), join(packed, "node_modules"), "dir");
  await assert.rejects(readdir(join(packed, "dist")), { code: "ENOENT" });
  const pi = await workspace.start(packed);
  const resources = await pi.inspect();
  assert.deepEqual(resources.tools.filter(name => name.startsWith("pbot_")).sort(), ["pbot_agent"]);
  assert.ok(resources.skills.length > 0);
  assert.equal((await pi.driver("context")).environment.workspaceRoot, workspace.root);
  assert.deepEqual(await readdir(workspace.root), []);
  assert.deepEqual((await pi.tool("pbot_agent", { action: "list" })).agents, []);
  assert.ok(!pi.records.some(record => record.type === "extension_error"));
  assert.deepEqual(await pi.stop(), { code: 0, signal: null });
});
