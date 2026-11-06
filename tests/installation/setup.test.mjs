import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { packageChoices, parseCatalog, parseSetupArgs, executeSetup } from "../../dist/services/installation/setup-service.js";
import { checkStableVersion, npmName, ordinaryNpm } from "../../dist/common/package-source.js";
import { SetupProcesses, findExecutable, tmuxInstallCommand } from "../../dist/integrations/installation/processes.js";
import { PiBootstrapRequired, PiSetup } from "../../dist/integrations/installation/pi-setup.js";
import { resolveWorkspace } from "../../dist/integrations/installation/workspace.js";

const exec = promisify(execFile), packageRoot = resolve("."), piRoot = resolve("node_modules/@earendil-works/pi-coding-agent");
const piCommand = join(piRoot, "dist/cli.js");
const catalog = parseCatalog(JSON.parse(await readFile("resources/installer/plugins.json", "utf8")));

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "pbot-install-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = join(temp, "工作 空间"), agentDir = join(temp, "agent"), home = join(temp, "home");
  await Promise.all([workspace, agentDir, home].map(path => mkdir(path)));
  const env = { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", LANG: "C.UTF-8" };
  const controller = new AbortController(), processes = new SetupProcesses(controller.signal, env);
  const host = new PiSetup(processes, await findExecutable("npm", env), workspace);
  return { temp, workspace, agentDir, home, env, controller, processes, host };
}

const plugin = (id, source = `npm:${id}`) => ({ id, source, label: id, description: id, defaultSelected: true });

test("setup arguments preserve paths and reject ambiguous or unsupported invocations", () => {
  assert.deepEqual(parseSetupArgs(["setup", "--workspace", "a b/研究"]), { action: "setup", workspace: "a b/研究" });
  assert.deepEqual(parseSetupArgs([]), { action: "help" });
  for (const args of [["unknown"], ["setup", "--workspace"], ["setup", "--workspace", "--yes"],
    ["setup", "--workspace", "a", "--workspace", "b"], ["setup", "--yes"]]) assert.throws(() => parseSetupArgs(args));
});

test("plugin catalog cannot contain duplicate package identities or non-npm execution sources", () => {
  assert.equal(parseCatalog([plugin("one")]).length, 1);
  for (const entries of [[plugin("one"), plugin("two", "npm:one")], [plugin("pbot")],
    [plugin("other", "npm:personal-bot")], [plugin("one", "git:github.com/a/b")],
    [plugin("one", "npm:one@1.2.3")], [{ ...plugin("one"), defaultSelected: "yes" }]]) {
    assert.throws(() => parseCatalog(entries));
  }
  assert.equal(npmName("npm:@example/a@1.2.3"), "@example/a");
  assert.equal(ordinaryNpm("npm:one@latest"), true);
  assert.equal(ordinaryNpm("npm:one@^1"), false);
  assert.equal(npmName("npm:one\n--global"), undefined);
});

test("latest must be stable and supported by the current Node runtime", () => {
  assert.equal(checkStableVersion("1.2.3", ">=22.19"), "1.2.3");
  assert.throws(() => checkStableVersion("1.2.3-beta.1"));
  assert.throws(() => checkStableVersion("invalid"));
  assert.throws(() => checkStableVersion("1.2.3", ">=999"));
});

test("fresh defaults, later additions, custom sources and npm scope overrides", () => {
  const fresh = packageChoices(catalog, []);
  assert.ok(fresh.every(item => item.selected));
  const existing = [{ name: "personal-bot", source: "npm:personal-bot", scope: "project", filtered: false, entry: "npm:personal-bot" }];
  assert.deepEqual(packageChoices(catalog, existing).map(item => item.selected), [true, false, false]);
  const pin = { ...existing[0], source: "npm:personal-bot@0.1.0" };
  assert.equal(packageChoices([], [pin])[0].keep, true);
  const overridden = packageChoices([], [pin, { ...existing[0], scope: "user" }])[0];
  assert.deepEqual(overridden.existing, [pin]);
});

test("workspace selection resolves symlink parents without preparing user files", async t => {
  const f = await fixture(t), alias = join(f.temp, "alias");
  await symlink(f.workspace, alias, "dir");
  assert.equal(await resolveWorkspace("~/new space", f.workspace, f.home), join(f.home, "new space"));
  assert.equal(await resolveWorkspace(join(alias, "new"), f.workspace, f.home), join(f.workspace, "new"));
  assert.deepEqual(await readdir(f.workspace), []);
  const file = join(f.workspace, "file"); await writeFile(file, "content");
  await assert.rejects(resolveWorkspace(join(file, "child"), f.workspace, f.home));
});

test("executable discovery excludes npx copies and uses actual persistent executables", async t => {
  const f = await fixture(t), cached = join(f.temp, "_npx/entry/node_modules/.bin"), persistent = join(f.temp, "bin");
  await mkdir(cached, { recursive: true }); await mkdir(persistent);
  await symlink(piCommand, join(cached, "pi")); await symlink(piCommand, join(persistent, "pi"));
  assert.equal(await findExecutable("pi", { PATH: `${cached}:${persistent}` }), join(persistent, "pi"));
  assert.equal(await findExecutable("pi", { PATH: cached }), undefined);
});

test("system tmux installation preserves package-manager and privilege boundaries", () => {
  assert.deepEqual(tmuxInstallCommand("darwin", new Map([["brew", "/opt/homebrew/bin/brew"]]), false),
    { command: "/opt/homebrew/bin/brew", args: ["install", "tmux"] });
  assert.deepEqual(tmuxInstallCommand("linux", new Map([["apt-get", "/usr/bin/apt-get"], ["sudo", "/usr/bin/sudo"]]), false),
    { command: "/usr/bin/sudo", args: ["/usr/bin/apt-get", "install", "-y", "tmux"] });
  assert.throws(() => tmuxInstallCommand("darwin", new Map(), false));
  assert.throws(() => tmuxInstallCommand("linux", new Map([["apk", "/sbin/apk"]]), false));
});

test("real child processes preserve cwd and argv and terminate on failure, timeout and cancellation", async t => {
  const f = await fixture(t), input = "a 'quote' $(not-a-command) 研究";
  const data = JSON.parse(await f.processes.run(process.execPath, ["-e", "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))", input], f.workspace));
  assert.equal(data.cwd, await resolveWorkspace(f.workspace, f.workspace, f.home));
  assert.equal(data.arg, input);
  await assert.rejects(f.processes.run(process.execPath, ["-e", "process.exit(7)"], f.workspace));
  await assert.rejects(f.processes.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], f.workspace, { timeoutMs: 100 }));
  const running = f.processes.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], f.workspace);
  f.controller.abort(new Error("cancelled"));
  await assert.rejects(running);
});

test("native Pi inspection is read-only and retains scoped source and filter information", async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, ".pi"));
  const global = JSON.stringify({ packages: ["npm:personal-bot@0.1.0"], quietStartup: true });
  const local = JSON.stringify({ packages: [{ source: packageRoot, skills: [], extensions: ["src/pbot.ts"] }], customSetting: 42 });
  await writeFile(join(f.agentDir, "settings.json"), global);
  await writeFile(join(f.workspace, ".pi/settings.json"), local);
  const pi = await f.host.inspectPi(piCommand);
  const records = await f.host.inspectPackages(pi, f.workspace);
  assert.equal(records.length, 2);
  assert.equal(records.find(pkg => pkg.scope === "project").name, "personal-bot");
  assert.equal(records.find(pkg => pkg.scope === "project").filtered, true);
  assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), global);
  assert.equal(await readFile(join(f.workspace, ".pi/settings.json"), "utf8"), local);
  assert.deepEqual(await readdir(join(f.workspace, ".pi")), ["settings.json"]);
  await writeFile(join(f.workspace, ".pi/settings.json"), "broken json");
  await assert.rejects(f.host.inspectPackages(pi, f.workspace));
});

test("native inspection rejects unidentified sources before planning without changing configuration", async t => {
  const f = await fixture(t), unnamed = join(f.temp, "unnamed-package");
  await mkdir(join(f.workspace, ".pi")); await mkdir(unnamed);
  const pi = await f.host.inspectPi(piCommand), localFile = join(f.workspace, ".pi/settings.json"), userFile = join(f.agentDir, "settings.json");
  const sources = [join(f.temp, "missing-checkout"), "git:github.com/realqiyan/personal-bot", unnamed];
  for (const scope of ["project", "user"]) {
    for (const source of sources) {
      const declared = JSON.stringify({ packages: [source], customSetting: 42 });
      const local = scope === "project" ? declared : "{}", user = scope === "user" ? declared : "{}";
      await writeFile(localFile, local); await writeFile(userFile, user);
      await assert.rejects(f.host.inspectPackages(pi, f.workspace));
      assert.equal(await readFile(localFile, "utf8"), local);
      assert.equal(await readFile(userFile, "utf8"), user);
      assert.deepEqual(await readdir(join(f.workspace, ".pi")), ["settings.json"]);
      assert.deepEqual(await readdir(f.agentDir), ["settings.json"]);
    }
  }
  await writeFile(userFile, "{}");
  await writeFile(localFile, JSON.stringify({ packages: [unnamed] }));
  for (const manifest of [{}, { name: " " }, { name: 42 }]) {
    await writeFile(join(unnamed, "package.json"), JSON.stringify(manifest));
    await assert.rejects(f.host.inspectPackages(pi, f.workspace));
  }
  await writeFile(join(unnamed, "package.json"), await readFile(join(packageRoot, "package.json"), "utf8"));
  const choice = packageChoices([], await f.host.inspectPackages(pi, f.workspace))[0];
  assert.equal(choice.keep, true);
  assert.deepEqual(choice.existing.map(pkg => pkg.source), [unnamed]);
});

test("native inspection preserves standalone extensions and recognizes uninstalled npm identities", async t => {
  const f = await fixture(t), extension = join(f.temp, "local-extension.ts");
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(extension, await readFile(join(packageRoot, "src/extension/setup-guard.ts")));
  const settings = JSON.stringify({ packages: [extension, "npm:personal-bot"] });
  await writeFile(join(f.workspace, ".pi/settings.json"), settings);
  const pi = await f.host.inspectPi(piCommand), records = await f.host.inspectPackages(pi, f.workspace);
  assert.equal(records.find(pkg => pkg.source === extension).installedPath, extension);
  assert.equal(records.find(pkg => pkg.source === extension).name, undefined);
  const choice = packageChoices([], records)[0];
  assert.equal(choice.keep, false);
  assert.deepEqual(choice.existing.map(pkg => pkg.source), ["npm:personal-bot"]);
  assert.equal(await readFile(join(f.workspace, ".pi/settings.json"), "utf8"), settings);
  assert.deepEqual(await readdir(join(f.workspace, ".pi")), ["settings.json"]);
});

test("native source replacement keeps filters, unrelated settings, source files and user configuration", async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, ".pi/npm/node_modules"), { recursive: true });
  await symlink(packageRoot, join(f.workspace, ".pi/npm/node_modules/personal-bot"), "dir");
  const target = "npm:personal-bot@latest";
  const before = { packages: [{ source: packageRoot, extensions: ["src/pbot.ts"], skills: [] }, target, "npm:unrelated"], customSetting: { keep: 42 } };
  await writeFile(join(f.workspace, ".pi/settings.json"), JSON.stringify(before));
  await writeFile(join(f.agentDir, "settings.json"), '{"theme":"dark"}');
  const pi = await f.host.inspectPi(piCommand), records = await f.host.inspectPackages(pi, f.workspace);
  const old = records.find(pkg => pkg.source === packageRoot);
  await f.processes.run(process.execPath, [resolve("dist/integrations/installation/pi-bridge.js"), "replace", pi.root, f.workspace,
    JSON.stringify({ old, target })], f.workspace);
  const after = JSON.parse(await readFile(join(f.workspace, ".pi/settings.json"), "utf8"));
  assert.deepEqual(after.packages, [{ ...before.packages[0], source: target }, "npm:unrelated"]);
  assert.deepEqual(after.customSetting, before.customSetting);
  assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), '{"theme":"dark"}');
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).name, "personal-bot");
  await assert.rejects(f.processes.run(process.execPath, [resolve("dist/integrations/installation/pi-bridge.js"), "replace", pi.root, f.workspace,
    JSON.stringify({ old, target })], f.workspace));
});

test("workspace npm overrides inherit global resource filters without changing the user declaration", async t => {
  const f = await fixture(t), target = "npm:personal-bot@latest";
  await mkdir(join(f.workspace, ".pi/npm/node_modules"), { recursive: true });
  await symlink(packageRoot, join(f.workspace, ".pi/npm/node_modules/personal-bot"), "dir");
  const global = { source: "npm:personal-bot", extensions: [], skills: ["!**/unused.md"] };
  const userSettings = JSON.stringify({ packages: [global], theme: "dark" });
  await writeFile(join(f.agentDir, "settings.json"), userSettings);
  await writeFile(join(f.workspace, ".pi/settings.json"), JSON.stringify({ packages: [target, "npm:unrelated"], theme: "light" }));
  const pi = await f.host.inspectPi(piCommand), records = await f.host.inspectPackages(pi, f.workspace);
  const old = records.find(pkg => pkg.scope === "user");
  await f.processes.run(process.execPath, [resolve("dist/integrations/installation/pi-bridge.js"), "replace", pi.root, f.workspace,
    JSON.stringify({ old, target })], f.workspace);
  const local = JSON.parse(await readFile(join(f.workspace, ".pi/settings.json"), "utf8"));
  assert.deepEqual(local, { packages: [{ ...global, source: target }, "npm:unrelated"], theme: "light" });
  assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), userSettings);
});

test("setup keeps an actual source installation and reports optional failures without invoking package installation", async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(join(f.workspace, ".pi/settings.json"), JSON.stringify({ packages: [packageRoot] }));
  const pi = await f.host.inspectPi(piCommand), choices = packageChoices(catalog, await f.host.inspectPackages(pi, f.workspace));
  choices[1].selected = true;
  choices[1].error = "No resolved target";
  const result = await executeSetup({ workspace: f.workspace, pi, piVersion: pi.version, packages: choices }, f.host, () => {}, f.controller.signal);
  assert.ok(result.pi);
  assert.deepEqual(result.results.map(item => item.state), ["done", "kept", "failed", "skipped"]);
  assert.deepEqual(await readdir(f.workspace), [".pi"]);
});

test("fresh Pi bootstrap distinguishes existing declarations from corrupt configuration", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.host.inspectPackages(undefined, f.workspace), []);
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(join(f.workspace, ".pi/settings.json"), JSON.stringify({ packages: ["npm:personal-bot"] }));
  await assert.rejects(f.host.inspectPackages(undefined, f.workspace), PiBootstrapRequired);
  await writeFile(join(f.workspace, ".pi/settings.json"), '{"packages":42}');
  await assert.rejects(f.host.inspectPackages(undefined, f.workspace), error => !(error instanceof PiBootstrapRequired));
});

test("a vanished retained source stops setup before optional plugins or launch", async t => {
  const f = await fixture(t), source = join(f.temp, "pbot-source");
  await symlink(packageRoot, source, "dir");
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(join(f.workspace, ".pi/settings.json"), JSON.stringify({ packages: [source] }));
  const pi = await f.host.inspectPi(piCommand), choices = packageChoices(catalog, await f.host.inspectPackages(pi, f.workspace));
  await rm(source);
  const result = await executeSetup({ workspace: f.workspace, pi, piVersion: pi.version, packages: choices }, f.host, () => {}, f.controller.signal);
  assert.equal(result.pi, undefined);
  assert.deepEqual(result.results.map(item => item.state), ["done", "failed"]);
});

test("CLI is usable without Pi and rejects non-interactive setup before filesystem changes", async t => {
  const f = await fixture(t);
  const cli = resolve("bin/pbot.mjs");
  const { stdout } = await exec(process.execPath, [cli, "--version"], { cwd: f.workspace, env: { HOME: f.home, PATH: "/usr/bin:/bin" } });
  assert.equal(stdout.trim(), JSON.parse(await readFile("package.json", "utf8")).version);
  await assert.rejects(exec(process.execPath, [cli, "setup", "--workspace", join(f.workspace, "new")], { cwd: f.workspace, env: f.env }), error => error.code === 2);
  assert.deepEqual(await readdir(f.workspace), []);
});
