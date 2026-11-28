import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostInstallerRegistry, listHostInstallers } from "../../dist/integrations/installation/installers/registry.js";
import { executeHostInstall, parseInstallArgs } from "../../dist/services/installation/install-service.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = resolve(repoRoot, "bin/pbot.mjs");

async function makeTempDir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function writeExecutable(dir, name, content) {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
  return path;
}

test("parseInstallArgs parses host/all targets and rejects invalid inputs", () => {
  const hosts = ["pi", "dsh", "claude", "antigravity", "codex", "qoder"];
  assert.deepEqual(parseInstallArgs(["all"], hosts), { help: false, target: "all", json: false });
  assert.deepEqual(
    parseInstallArgs(["dsh", "--workspace", "/tmp/ws", "--dsh-profile", "custom", "--json"], hosts),
    { help: false, target: "dsh", workspace: "/tmp/ws", dshProfile: "custom", json: true },
  );
  assert.deepEqual(parseInstallArgs(["--help"], hosts), { help: true, json: false });
  assert.throws(() => parseInstallArgs([], hosts));
  assert.throws(() => parseInstallArgs(["unknown"], hosts));
  assert.throws(() => parseInstallArgs(["pi", "codex"], hosts));
  assert.throws(() => parseInstallArgs(["pi", "--unknown"], hosts));
});

test("HostInstallerRegistry registers built-in hosts and supports custom installers", async () => {
  const builtIns = listHostInstallers();
  for (const host of ["pi", "dsh", "claude", "antigravity", "codex", "qoder"]) {
    assert.ok(builtIns.includes(host), `missing built-in installer: ${host}`);
  }

  const registry = new HostInstallerRegistry();
  registry.register({
    host: "custom-host",
    async install() {
      return { host: "custom-host", state: "installed", detail: "custom installed" };
    },
  });
  registry.register({
    host: "failing-host",
    async install() {
      throw new Error("boom");
    },
  });

  const controller = new AbortController();
  const summary = await executeHostInstall({
    workspaceRoot: "/tmp/ws",
    target: "all",
    hosts: ["failing-host", "custom-host", "unregistered-host"],
    resolveInstaller: host => registry.get(host),
    createContext: (_host, explicit) => ({
      workspace: "/tmp/ws",
      packageRoot: repoRoot,
      explicit,
      env: process.env,
      signal: controller.signal,
      options: {},
      run: async () => "",
      findExecutable: async () => undefined,
    }),
    signal: controller.signal,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.results.length, 3);
  assert.equal(summary.results[0].state, "failed");
  assert.equal(summary.results[1].state, "installed");
  assert.equal(summary.results[2].state, "skipped");
});

test("pbot install <host> and pbot install all invoke native host CLIs", async () => {
  const home = await makeTempDir("pbot-install-home-");
  const workspace = await makeTempDir("pbot-install-ws-");
  const binDir = await makeTempDir("pbot-install-bin-");
  const logFile = join(home, "invocations.log");

  try {
    const logger = `printf '%s\\n' "$0 $*" >> ${JSON.stringify(logFile)}`;
    await writeExecutable(binDir, "pi", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "dsh", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "claude", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "agy", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "codex", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "qodercli", `#!/bin/sh\n${logger}\nexit 0\n`);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    const allRun = spawnSync(
      process.execPath,
      [cliEntry, "install", "all", "--workspace", workspace, "--dsh-profile", "myprof", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(allRun.status, 0, allRun.stderr + "\n" + allRun.stdout);
    const summary = JSON.parse(allRun.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.target, "all");
    const byHost = Object.fromEntries(summary.results.map(item => [item.host, item]));
    for (const host of ["pi", "dsh", "claude", "antigravity", "codex", "qoder"]) {
      assert.equal(byHost[host].state, "installed", `expected ${host} installed`);
    }
    assert.equal(byHost.dsh.scope, "profile:myprof");

    const log = await readFile(logFile, "utf8");
    assert.match(log, /pi install --local npm:personal-bot/);
    assert.match(log, /dsh plugin --profile myprof add personal-bot@latest/);
    assert.match(log, /claude plugin install personal-bot --marketplace realqiyan\/personal-bot --yes/);
    assert.match(log, /agy plugin install .*lib\/antigravity-plugin/);
    assert.match(log, /codex plugin marketplace add .*lib\/codex-marketplace/);
    assert.match(log, /codex plugin add personal-bot@pbot-local/);
    assert.match(log, /qodercli plugin install .*lib\/qoder-plugin/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("pbot install all skips missing CLIs while explicit host install fails when CLI is missing", async () => {
  const home = await makeTempDir("pbot-install-miss-home-");
  const workspace = await makeTempDir("pbot-install-miss-ws-");
  const binDir = await makeTempDir("pbot-install-miss-bin-");

  try {
    await writeExecutable(binDir, "agy", "#!/bin/sh\nexit 0\n");
    const env = { ...process.env, HOME: home, PATH: binDir };

    // install all: agy installs, others skip, overall ok
    const allRun = spawnSync(
      process.execPath,
      [cliEntry, "install", "all", "--workspace", workspace, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(allRun.status, 0, allRun.stderr + "\n" + allRun.stdout);
    const allSummary = JSON.parse(allRun.stdout);
    assert.equal(allSummary.ok, true);
    const byHost = Object.fromEntries(allSummary.results.map(item => [item.host, item]));
    assert.equal(byHost.antigravity.state, "installed");
    assert.equal(byHost.pi.state, "skipped");
    assert.equal(byHost.claude.state, "skipped");

    // explicit install pi when pi is missing: fails with exit 1
    const piRun = spawnSync(
      process.execPath,
      [cliEntry, "install", "pi", "--workspace", workspace, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(piRun.status, 1);
    const piSummary = JSON.parse(piRun.stdout);
    assert.equal(piSummary.ok, false);
    assert.equal(piSummary.results[0].state, "failed");

    // removed commands fail cleanly
    for (const removed of ["setup", "install-antigravity"]) {
      const res = spawnSync(process.execPath, [cliEntry, removed], { env, encoding: "utf8" });
      assert.equal(res.status, 2);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
