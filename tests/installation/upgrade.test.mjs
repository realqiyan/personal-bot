import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostUpgraderRegistry, listHostUpgraders } from "../../dist/integrations/installation/upgraders/registry.js";
import { inferDshProfile } from "../../dist/integrations/installation/upgraders/dsh.js";
import { executeWorkspaceUpgrade, parseUpgradeArgs } from "../../dist/services/installation/upgrade-service.js";
import { workspacePluginDrift } from "../../dist/services/workspace/plugin-releases.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = resolve(repoRoot, "bin/pbot.mjs");
const { version: currentVersion } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));

async function makeTempDir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function writeExecutable(dir, name, content) {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function bindHost(home, workspace, host, binding) {
  const key = createHash("sha256").update(workspace).digest("hex");
  const dir = join(home, ".pbot", "workspaces", key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${encodeURIComponent(host)}.json`), JSON.stringify(binding), "utf8");
}

test("parseUpgradeArgs parses flags and rejects invalid inputs", () => {
  assert.deepEqual(parseUpgradeArgs([]), { help: false, json: false });
  assert.deepEqual(
    parseUpgradeArgs(["--workspace", "/tmp/ws", "--version=0.3.3", "--hosts", "claude,codex,claude", "--dsh-profile", "pbot", "--json"]),
    { help: false, workspace: "/tmp/ws", version: "0.3.3", hosts: ["claude", "codex"], dshProfile: "pbot", json: true },
  );
  assert.deepEqual(parseUpgradeArgs(["--help"]), { help: true, json: false });
  assert.throws(() => parseUpgradeArgs(["--version", "not-a-semver"]));
  assert.throws(() => parseUpgradeArgs(["--unknown"]));
});

test("workspacePluginDrift detects version mismatch across hosts", () => {
  assert.equal(workspacePluginDrift({}).outOfSync, false);
  assert.equal(workspacePluginDrift({ claude: "0.3.3" }).outOfSync, false);
  assert.equal(workspacePluginDrift({ claude: "0.3.3", codex: "0.3.3" }).outOfSync, false);
  const drift = workspacePluginDrift({ claude: "0.3.3", codex: "0.3.1" });
  assert.equal(drift.outOfSync, true);
  assert.equal(drift.highest, "0.3.3");
  assert.equal(drift.lowest, "0.3.1");
});

test("HostUpgraderRegistry isolates hosts and supports custom upgrader extension without modifying core orchestration", async () => {
  const builtIns = listHostUpgraders();
  for (const host of ["pi", "claude", "antigravity", "codex", "qoder", "dsh"]) {
    assert.ok(builtIns.includes(host), `missing built-in upgrader: ${host}`);
  }
  assert.equal(inferDshProfile("/Users/me/.dsh/profiles/pbot/node_modules/personal-bot/package.json"), "pbot");
  assert.equal(inferDshProfile("/Users/me/other/package.json"), undefined);

  const registry = new HostUpgraderRegistry();
  registry.register({
    host: "custom-host",
    async upgrade(ctx) {
      return { host: "custom-host", state: "updated", previousVersion: ctx.currentVersion, version: ctx.targetVersion, detail: "custom upgraded" };
    },
  });
  registry.register({
    host: "failing-host",
    async upgrade() {
      throw new Error("boom");
    },
  });

  const controller = new AbortController();
  const summary = await executeWorkspaceUpgrade({
    workspaceRoot: "/tmp/ws",
    targetVersion: "0.3.3",
    cli: { state: "up-to-date", previousVersion: "0.3.3", version: "0.3.3", detail: "ok" },
    targets: [
      { host: "failing-host", currentVersion: "0.3.1" },
      { host: "custom-host", currentVersion: "0.3.1" },
      { host: "unregistered-host", currentVersion: "0.3.1" },
    ],
    resolveUpgrader: host => registry.get(host),
    createContext: target => ({
      workspace: "/tmp/ws",
      targetVersion: "0.3.3",
      ...(target.currentVersion ? { currentVersion: target.currentVersion } : {}),
      packageRoot: repoRoot,
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
  assert.equal(summary.results[1].state, "updated");
  assert.equal(summary.results[1].version, "0.3.3");
  assert.equal(summary.results[2].state, "skipped");
});

test("pbot upgrade and update unify bound hosts in a workspace while preserving scopes and isolating failures", async () => {
  const home = await makeTempDir("pbot-upgrade-home-");
  const workspace = await makeTempDir("pbot-upgrade-ws-");
  const binDir = await makeTempDir("pbot-upgrade-bin-");
  const logFile = join(home, "invocations.log");

  try {
    // Enable workspace
    await mkdir(join(workspace, ".pbot"), { recursive: true });
    await writeFile(join(workspace, ".pbot", "config.json"), JSON.stringify({ enabled: true }), "utf8");

    // Create a fake dsh profile binding manifest
    const dshManifest = join(home, ".dsh", "profiles", "pbot", "node_modules", "personal-bot", "package.json");
    await mkdir(resolve(dshManifest, ".."), { recursive: true });
    await writeFile(dshManifest, JSON.stringify({ name: "personal-bot", version: "0.3.1" }), "utf8");

    // Bind multiple hosts at older/mixed versions to trigger drift
    await bindHost(home, workspace, "claude", "0.3.1");
    await bindHost(home, workspace, "antigravity", "0.3.1");
    await bindHost(home, workspace, "codex", "0.3.1");
    await bindHost(home, workspace, "qoder", currentVersion); // already up-to-date
    await bindHost(home, workspace, "pi", "0.3.1");
    await bindHost(home, workspace, "dsh", dshManifest);

    // Fake host CLIs that record invocations
    const logger = `printf '%s\\n' "$0 $*" >> ${JSON.stringify(logFile)}`;
    await writeExecutable(binDir, "claude", `#!/bin/sh
${logger}
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  printf '[{"id":"personal-bot@personal-bot","version":"0.3.1","scope":"local","projectPath":"%s"},{"id":"personal-bot@personal-bot","version":"0.3.1","scope":"user"}]\\n' ${JSON.stringify(workspace)}
  exit 0
fi
exit 0
`);
    await writeExecutable(binDir, "agy", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "codex", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "qodercli", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "pi", `#!/bin/sh\n${logger}\nexit 0\n`);
    await writeExecutable(binDir, "dsh", `#!/bin/sh\n${logger}\nexit 0\n`);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    // 1. pbot status should report outOfSync: true
    const statusRun = spawnSync(process.execPath, [cliEntry, "status", "--workspace", workspace, "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(statusRun.status, 0, statusRun.stderr);
    const statusJson = JSON.parse(statusRun.stdout);
    assert.equal(statusJson.outOfSync, true);

    // 2. pbot update (alias for upgrade) with --version <currentVersion>
    const upgradeRun = spawnSync(
      process.execPath,
      [cliEntry, "update", "--workspace", workspace, "--version", currentVersion, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(upgradeRun.status, 0, upgradeRun.stderr + "\n" + upgradeRun.stdout);
    const summary = JSON.parse(upgradeRun.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.targetVersion, currentVersion);
    assert.equal(summary.cli.state, "up-to-date");

    const byHost = Object.fromEntries(summary.results.map(item => [item.host, item]));
    assert.equal(byHost.claude.state, "updated");
    assert.equal(byHost.claude.scope, "local");
    assert.equal(byHost.antigravity.state, "updated");
    assert.equal(byHost.codex.state, "updated");
    assert.equal(byHost.qoder.state, "up-to-date");
    assert.equal(byHost.pi.state, "updated");
    assert.equal(byHost.pi.scope, "local");
    assert.equal(byHost.dsh.state, "updated");
    assert.equal(byHost.dsh.scope, "profile:pbot");

    const log = await readFile(logFile, "utf8");
    assert.match(log, /claude plugin update personal-bot@personal-bot --yes --scope local/);
    assert.match(log, /agy plugin install .*lib\/antigravity-plugin/);
    assert.match(log, /codex plugin marketplace add .*lib\/codex-marketplace/);
    assert.match(log, /codex plugin add personal-bot@pbot-local/);
    assert.doesNotMatch(log, /qodercli plugin install/);
    assert.match(log, new RegExp(`pi install --local npm:personal-bot@${currentVersion.replaceAll(".", "\\.")}`));
    assert.match(log, /dsh plugin --profile pbot update personal-bot --latest/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("pi upgrader skips non-npm custom sources and dsh skips when profile cannot be inferred", async () => {
  const home = await makeTempDir("pbot-upgrade-skip-home-");
  const workspace = await makeTempDir("pbot-upgrade-skip-ws-");
  const binDir = await makeTempDir("pbot-upgrade-skip-bin-");
  try {
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({ packages: ["/local/dev/personal-bot"] }), "utf8");
    await bindHost(home, workspace, "pi", "0.3.1");
    await bindHost(home, workspace, "dsh", "0.3.1");
    await writeExecutable(binDir, "pi", "#!/bin/sh\nexit 1\n");
    await writeExecutable(binDir, "dsh", "#!/bin/sh\nexit 1\n");

    const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const run = spawnSync(
      process.execPath,
      [cliEntry, "upgrade", "--workspace", workspace, "--version", currentVersion, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr + "\n" + run.stdout);
    const summary = JSON.parse(run.stdout);
    const byHost = Object.fromEntries(summary.results.map(item => [item.host, item]));
    assert.equal(byHost.pi.state, "skipped");
    assert.equal(byHost.dsh.state, "skipped");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
