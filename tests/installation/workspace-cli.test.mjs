import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { recordHistoryCapture } from "../../dist/services/history/history-capture.js";

const exec = promisify(execFile);
const cli = resolve("bin/pbot.mjs");
const manifest = JSON.parse(await readFile("package.json", "utf8"));

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pbot cli ")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const workspace = join(cwd, "workspace 一");
  const env = { PATH: process.env.PATH, HOME: cwd, npm_config_cache: join(cwd, "npm-cache"), npm_config_offline: "true" };
  const run = (args, options = {}) => exec(process.execPath, [cli, ...args], { cwd, env, timeout: 30000, ...options });
  return { cwd, workspace, env, run };
}

async function jsonStdin(run, args, input, options) {
  const child = run(args, options);
  child.child.stdin.end(JSON.stringify(input) + "\n");
  return JSON.parse((await child).stdout);
}

test("inactive workspaces and local version probes leave npm untouched", async t => {
  const { cwd, workspace, env, run } = await fixture(t);
  const installed = join(workspace, ".pi/npm/node_modules/personal-bot");
  await mkdir(installed, { recursive: true });
  const nextVersion = `${Number(manifest.version.split(".")[0]) + 1}.0.0`;
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: manifest.name, version: nextVersion }));
  await mkdir(join(workspace, ".pbot"));
  await mkdir(join(cwd, ".pbot"));
  await writeFile(join(cwd, ".pbot/config.json"), '{"enabled":true}');
  const config = join(workspace, ".pbot/config.json");
  const hostEnv = { ...env, PBOT_WORKSPACE_ROOT: workspace, PBOT_PLUGIN_VERSION: nextVersion };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" },
  } };
  const hook = { hook_event_name: "UserPromptSubmit", cwd: workspace, session_id: "inactive", prompt: "input" };
  for (const content of [undefined, '{"enabled":false}', "damaged"]) {
    if (content !== undefined) await writeFile(config, content);
    const status = run(["status", "--workspace", workspace, "--json"]);
    let result;
    if (content === "damaged") {
      await assert.rejects(status, error => { result = JSON.parse(error.stdout); return error.code === 1; });
      await assert.rejects(run(["init", "--workspace", workspace]), error => error.stderr.includes(config));
      assert.equal(await readFile(config, "utf8"), content);
    } else result = JSON.parse((await status).stdout);
    assert.equal(result.configuration.enabled, false);
    assert.equal(result.minimumCliVersion, null);
    assert.deepEqual(result.plugins, {});
    await assert.rejects(run(["history", "status", "--workspace", workspace]), error => error.code === 1 && error.stderr.includes(config));
    assert.equal((await jsonStdin(run, ["mcp"], init, { env: hostEnv })).result.serverInfo.version, manifest.version);
    assert.deepEqual(await jsonStdin(run, ["plugin", "codex", "hook"], hook, { env: hostEnv }), {});
  }
  await writeFile(config, '{"enabled":true,"features":{"history":false}}');
  await assert.rejects(run(["history", "status", "--workspace", workspace]), error => error.stderr.includes("features.history"));
  for (const flag of ["-v", "--version"]) {
    assert.equal((await run([flag], { cwd: workspace, env: hostEnv })).stdout.trim(), manifest.version);
  }
  await assert.rejects(access(env.npm_config_cache), { code: "ENOENT" });
});

test("a read-only binding cache allows host hooks and other readable bindings", async t => {
  const { cwd, workspace, env, run } = await fixture(t);
  await run(["init", "--workspace", workspace]);
  const home = join(cwd, "readonly-home");
  await mkdir(home, { mode: 0o555 });
  const options = { cwd: workspace, env: { ...env, HOME: home, PBOT_PLUGIN_VERSION: manifest.version } };
  const payload = { hook_event_name: "UserPromptSubmit", cwd: workspace, session_id: "readonly", prompt: "input" };
  const hook = () => jsonStdin(run, ["plugin", "codex", "hook"], payload, options);
  const status = async () => JSON.parse((await run(["status", "--json"], options)).stdout);
  try {
    assert.equal((await hook()).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    if (process.getuid() !== 0) assert.deepEqual(await readdir(home), []);
  } finally { await chmod(home, 0o700); }
  await hook();
  await run(["plugin", "qoder", "init"], options);
  const bindings = join(home, ".pbot/workspaces", createHash("sha256").update(workspace).digest("hex"));
  const file = join(bindings, "codex.json");
  assert.deepEqual((await status()).plugins, { codex: manifest.version, qoder: manifest.version });
  await chmod(file, 0);
  try {
    assert.equal((await hook()).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    if (process.getuid() !== 0) assert.deepEqual((await status()).plugins, { qoder: manifest.version });
  } finally { await chmod(file, 0o600); }
  await writeFile(file, "invalid");
  await assert.rejects(status(), error => error.stderr.includes("codex.json"));
});

test("workspace CLI binds roots, queries archives, reports partial failures, and migrates only on request", async t => {
  const { workspace, env, run } = await fixture(t);
  const call = async (...args) => JSON.parse((await run([...args, "--workspace", workspace, "--json"])).stdout);
  const initialized = await call("init");
  assert.equal(initialized.workspaceRoot, workspace);
  assert.equal(initialized.version, manifest.version);
  assert.equal(initialized.configuration.enabled, true);
  assert.equal((await call("status")).configuration.enabled, true);
  assert.equal(JSON.parse((await run(["--workspace=" + workspace, "--json", "status"])).stdout).workspaceRoot, workspace);
  assert.equal((await call("history", "status")).rawCount, 0);
  assert.deepEqual((await call("history", "list")).dimensions.map(item => item.id), ["session", "monthly"]);
  const nested = join(workspace, "projects");
  await assert.rejects(run(["history", "status"], { cwd: nested }), { code: 1 });
  const empty = await run(["history", "summary", "--workspace", "../", "--json"], { cwd: nested, env: { ...env, PATH: "" } });
  assert.equal(JSON.parse(empty.stdout).dimensions[0].created, 0);
  assert.notEqual(empty.stderr, "");

  const config = join(workspace, ".pbot/config.json");
  await writeFile(config, JSON.stringify({ enabled: true, history: { layout: "flat" } }));
  await assert.rejects(run(["history", "summary", "monthly", "--workspace", workspace]), { code: 1 });
  const query = "quoted words (本地)";
  recordHistoryCapture(workspace, "codex", { kind: "input", sessionId: "thread", text: query });
  recordHistoryCapture(workspace, "codex", { kind: "answer", sessionId: "thread", assistantText: "done", completed: true });
  const search = await call("history", "search", query, "--host", "codex", "--session-id", "thread", "--limit", "1");
  assert.equal(search.total, 1);
  const read = await call("history", "read", search.matches[0].id, "--offset", "0", "--limit", "5");
  assert.equal(read.node.text.length, 5);
  assert.equal(read.node.nextOffset, 5);
  await assert.rejects(call("history", "search", "--limit", "51"), { code: 1 });
  await assert.rejects(call("history", "read"), { code: 1 });

  await writeFile(config, JSON.stringify({ enabled: true, acp: { unavailable: { command: process.execPath, args: ["--version"] } } }));
  assert.equal((await call("history", "migrate", "--dry-run")).moved.length, 1);
  assert.equal((await call("history", "migrate")).moved.length, 1);
  assert.equal((await call("history", "migrate")).moved.length, 0);
  await assert.rejects(run(["history", "summary", "session", "--backend", "unavailable", "--workspace", workspace, "--json"]),
    error => error.code === 1 && JSON.parse(error.stdout).dimensions[0].failed.length === 1);
  assert.equal((await call("history", "search", query)).total, 1);
  await writeFile(config, JSON.stringify({ enabled: true, features: { history: false } }));
  for (const subcommand of ["status", "list", "migrate", "summary", "search", "read"]) {
    await assert.rejects(call("history", subcommand), { code: 1 });
  }
  await writeFile(config, "damaged");
  await assert.rejects(call("init"), { code: 1 });
  assert.equal(await readFile(config, "utf8"), "damaged");
});

test("interrupting a CLI summary stops the ACP process and leaves the session pending", async t => {
  const { cwd, workspace, run } = await fixture(t);
  await run(["init", "--workspace", workspace]);
  const marker = join(cwd, "backend.pid");
  const args = ["-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.stdin.resume();', marker];
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true, acp: { waiting: { command: process.execPath, args } } }));
  recordHistoryCapture(workspace, "pi", { kind: "input", sessionId: "pending", text: "task" });
  recordHistoryCapture(workspace, "pi", { kind: "answer", sessionId: "pending", assistantText: "result", completed: true });
  const summary = run(["history", "summary", "session", "--backend", "waiting", "--workspace", workspace]);
  t.after(() => summary.child.kill("SIGTERM"));
  const pid = await t.waitFor(async () => {
    const value = Number(await readFile(marker, "utf8"));
    assert.ok(Number.isInteger(value) && value > 1);
    return value;
  }, { timeout: 10000 });
  summary.child.kill("SIGINT");
  await assert.rejects(summary, { code: 130 });
  await t.waitFor(() => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }));
  const status = await run(["history", "status", "--workspace", workspace, "--json"]);
  assert.equal(JSON.parse(status.stdout).dimensions[0].pendingCreate, 1);
});

// Serve a real npm tarball containing the bundled CLI. All npm installations and caches belong to this test.
test("an older CLI installs the workspace release, replays once, and reuses it offline", async t => {
  const { cwd, workspace, env, run } = await fixture(t);
  const [major, minor] = manifest.version.split(".").map(Number);
  const version = `${major}.${minor + 10}.0`;
  const source = join(cwd, "release");
  await mkdir(source);
  await cp("bin", join(source, "bin"), { recursive: true });
  await cp("resources", join(source, "resources"), { recursive: true });
  await cp("lib/antigravity-plugin/lib", join(source, "lib"), { recursive: true });
  const pkg = { name: "personal-bot", version, type: "module", bin: manifest.bin };
  await writeFile(join(source, "package.json"), JSON.stringify(pkg));
  await exec("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", cwd], { cwd: source, env: { ...env, npm_config_cache: join(cwd, "pack-cache") } });
  const tarball = await readFile(join(cwd, `personal-bot-${version}.tgz`));
  let downloads = 0;
  const registry = createServer((request, response) => {
    if (request.url === "/personal-bot") {
      response.setHeader("content-type", "application/json");
      const dist = { tarball: `${url}package.tgz`, integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64") };
      response.end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: version }, versions: { [version]: { ...pkg, dist } } }));
    } else if (request.url === "/package.tgz") {
      downloads++;
      response.end(tarball);
    } else { response.writeHead(404).end(); }
  });
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
  t.after(() => registry.close());
  const url = `http://127.0.0.1:${registry.address().port}/`;
  const online = { ...env, npm_config_registry: url, npm_config_offline: "false", npm_config_fetch_retries: "0" };
  // History commands can discover a host-managed installation even from a different working directory.
  const installed = join(workspace, ".pi/npm/node_modules/personal-bot");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify(pkg));

  const args = ["init", "--workspace", workspace, "--json"];
  const first = await run(args, { env: online });
  const result = JSON.parse(first.stdout);
  assert.equal(result.workspaceRoot, workspace);
  assert.equal(result.version, version);
  assert.equal(result.minimumCliVersion, version);
  assert.equal(downloads, 1);
  const offline = { ...online, npm_config_offline: "true" };
  const cached = await run(["status", "--workspace", workspace, "--json"], { env: offline });
  assert.equal(JSON.parse(cached.stdout).version, version);
  const hook = await jsonStdin(run, ["plugin", "codex", "hook"], {
    hook_event_name: "UserPromptSubmit", cwd: workspace, session_id: "updated", prompt: "input",
  }, { env: offline });
  const context = JSON.parse(hook.hookSpecificOutput.additionalContext.split("\n\n").at(-1));
  assert.equal(context.workspaceRoot, workspace);
  assert.equal(JSON.parse(await readFile(join(context.resourceRoot, "../package.json"), "utf8")).version, version);
  assert.equal(downloads, 1);
  await writeFile(join(source, "package.json"), JSON.stringify({ ...pkg, version: manifest.version }));
  await exec("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", cwd], { cwd: source, env });
  const oldArchive = join(cwd, `personal-bot-${manifest.version}.tgz`);
  const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  // An actual project dependency stays pinned even when a newer host plugin is bound to the same root.
  await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true }));
  await exec("npm", [...install, oldArchive], { cwd: workspace, env: offline });
  const lockPath = join(workspace, "package-lock.json");
  const lock = await readFile(lockPath, "utf8");
  const local = await exec(join(workspace, "node_modules/.bin/pbot"), ["status", "--json"], { cwd: workspace, env: offline });
  assert.equal(JSON.parse(local.stdout).version, version);
  assert.equal(await readFile(lockPath, "utf8"), lock);
  assert.equal(JSON.parse(await readFile(join(workspace, "node_modules/personal-bot/package.json"), "utf8")).version, manifest.version);
  // An in-place upgrade of a genuine npm global installation survives leaving the workspace.
  const prefix = join(cwd, "global");
  const globalEnv = { ...online, npm_config_prefix: prefix };
  await exec("npm", [...install, "--global", oldArchive], { cwd, env: globalEnv });
  const globalCli = join(prefix, "bin/pbot");
  const upgraded = await exec(globalCli, ["status", "--workspace", workspace, "--json"], { cwd, env: globalEnv });
  assert.equal(JSON.parse(upgraded.stdout).version, version);
  assert.equal((await exec(globalCli, ["--version"], { cwd, env: globalEnv })).stdout.trim(), version);
  assert.equal(JSON.parse(await readFile(join(prefix, "lib/node_modules/personal-bot/package.json"), "utf8")).version, version);
  const fresh = join(cwd, "untouched");
  await assert.rejects(run(["init", "--workspace", fresh], { env: { ...offline, PBOT_PLUGIN_VERSION: `${major}.${minor + 11}.0` } }));
  await assert.rejects(access(fresh), { code: "ENOENT" });
  assert.equal((await run(["--version"])).stdout.trim(), manifest.version);
});

test("host bindings follow the installed manifest, drop removed installs and stay workspace-local", async t => {
  const { cwd, workspace, env, run } = await fixture(t);
  await run(["init", "--workspace", workspace]);
  const plugin = join(cwd, "installed plugin.json");
  const bind = async host => exec(process.execPath, [resolve("lib/plugin.js"), host, "init"], {
    cwd: workspace, env: { ...env, PBOT_PLUGIN_MANIFEST: plugin },
  });
  await writeFile(plugin, JSON.stringify({ name: "personal-bot", version: "0.1.0" }));
  await Promise.all([bind("codex"), bind("qoder")]);
  const status = async () => JSON.parse((await run(["status", "--workspace", workspace, "--json"])).stdout);
  assert.deepEqual((await status()).plugins, { codex: "0.1.0", qoder: "0.1.0" });
  await writeFile(plugin, JSON.stringify({ name: "personal-bot", version: "0.2.0" }));
  assert.equal((await status()).minimumCliVersion, "0.2.0");
  assert.equal((await status()).version, manifest.version);
  assert.deepEqual(JSON.parse((await run(["status", "--workspace", join(workspace, "projects")])).stdout).plugins, {});
  await rm(plugin);
  assert.deepEqual((await status()).plugins, {});
});
