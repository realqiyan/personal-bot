import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

for (const enabled of [false, true]) test("native startup initialization is handled without a model; pbot=" + enabled, { timeout: 30_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "pbot-init-guard-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = join(temp, "workspace"), home = join(temp, "home"), agentDir = join(temp, "agent");
  await Promise.all([workspace, home, agentDir].map(path => mkdir(path)));
  // Actual invalid shared environments prevent network setup on both supported systems.
  await mkdir(join(home, "data/pbot/python/.venv"), { recursive: true });
  await mkdir(join(home, "Library/Application Support/pbot/python/.venv"), { recursive: true });
  const { stdout } = await exec(process.execPath, [resolve("tests/installation/guard-driver.mjs"), workspace, agentDir, resolve("."), enabled ? "yes" : "no"], {
    cwd: workspace, timeout: 25_000, env: { HOME: home, XDG_DATA_HOME: join(home, "data"),
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
  });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, { disposition: "handled", initialized: enabled, messages: 0 });
});
