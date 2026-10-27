import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { readJsonFile, writeJsonFile } from "../../dist/storage/atomic-json.js";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function record(value) {
  assert.equal(typeof value, "object");
  assert.equal(typeof value.generation, "number");
  assert.equal(typeof value.payload, "string");
  assert.deepEqual(Object.keys(value).sort(), ["generation", "payload"]);
  return value;
}
const initial = { generation: 0, payload: "original" };

test("atomic JSON validates before replacing and writes private, complete plain data", async t => {
  const root = await directory(t);
  writeJsonFile(root, "record.json", initial, record);
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.equal(await readFile(join(root, "record.json"), "utf8"), JSON.stringify(initial, null, 2) + "\n");
  assert.equal((await stat(join(root, "record.json"))).mode & 0o777, 0o600);
  for (const value of [{ generation: "0", payload: "invalid" }, { ...initial, extra: true }]) {
    assert.throws(() => writeJsonFile(root, "record.json", value, record));
  }
  for (const value of [{ value: undefined }, { value: Infinity }, { value: 1n }, new Date(), new Array(1)]) {
    assert.throws(() => writeJsonFile(root, "record.json", value, value => value));
  }
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.deepEqual(await readdir(root), ["record.json"]);
  assert.equal(writeJsonFile(root, "record.json", { generation: 1, payload: "new" }, record, true), false);
  assert.deepEqual(readJsonFile(root, "record.json", record), initial);
  assert.equal(writeJsonFile(root, "created.json", initial, record, true), true);
  assert.deepEqual(await readdir(root), ["created.json", "record.json"]);
});

test("internal JSON rejects aliases, traversal, malformed JSON and non-files without repair", async t => {
  const root = await directory(t), outside = await directory(t);
  await writeFile(join(outside, "record.json"), JSON.stringify(initial));
  await symlink(outside, join(root, "alias"));
  await symlink(join(outside, "record.json"), join(root, "linked.json"));
  await symlink(join(outside, "missing.json"), join(root, "dangling.json"));
  await mkdir(join(root, "directory.json"));
  for (const path of ["../record.json", "/record.json", "./record.json", "a//record.json", "a\\record.json",
    "alias/record.json", "linked.json", "dangling.json", "directory.json"]) {
    assert.throws(() => readJsonFile(root, path, record));
    assert.throws(() => writeJsonFile(root, path, initial, record));
  }
  assert.equal(await readFile(join(outside, "record.json"), "utf8"), JSON.stringify(initial));
  assert.deepEqual(await readdir(outside), ["record.json"]);
  await writeFile(join(root, "broken.json"), "{broken");
  assert.throws(() => readJsonFile(root, "broken.json", record));
  assert.equal(await readFile(join(root, "broken.json"), "utf8"), "{broken");
  const fifo = spawnSync("mkfifo", [join(root, "pipe.json")]);
  assert.equal(fifo.status, 0);
  assert.throws(() => readJsonFile(root, "pipe.json", record));
  assert.throws(() => writeJsonFile(root, "pipe.json", initial, record));
});

test("concurrent readers see a complete old or new JSON document", { timeout: 20_000 }, async t => {
  const root = await directory(t);
  writeJsonFile(root, "record.json", { generation: 0, payload: "0".repeat(16_384) }, record);
  const module = new URL("../../dist/storage/atomic-json.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeJsonFile } from ${JSON.stringify(module)};
    for (let generation = 1; generation <= 100; generation++) {
      writeJsonFile(${JSON.stringify(root)}, "record.json", { generation, payload: String(generation).repeat(16384) }, value => value);
    }
  `], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let error = "", done = false;
  child.stderr.setEncoding("utf8").on("data", value => { error += value; });
  const finished = once(child, "exit").then(([code]) => { done = true; assert.equal(code, 0, error); });
  while (!done) {
    const current = readJsonFile(root, "record.json", record);
    assert.equal(current.payload, String(current.generation).repeat(16_384));
    await setImmediate();
  }
  await finished;
  assert.equal(readJsonFile(root, "record.json", record).generation, 100);
  assert.deepEqual(await readdir(root), ["record.json"]);
});
