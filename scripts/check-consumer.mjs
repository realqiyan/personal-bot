import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2]);
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = await mkdtemp(join(tmpdir(), "pbot-consumer-"));
const consumer = join(root, "consumer"), home = join(root, "home"), workspace = join(root, "workspace");
await Promise.all([consumer, home, workspace].map(path => mkdir(path)));
const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, "data"),
  LANG: "C.UTF-8", npm_config_cache: join(root, "cache"), npm_config_engine_strict: "true" };
const npm = args => execFileSync("npm", args, { cwd: consumer, env, stdio: "inherit", timeout: 180_000 });
try {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const require = createRequire(join(consumer, "package.json"));
  for (const host of ["@earendil-works/pi-coding-agent", "@deepseek-ai/dsh", "@deepseek-ai/dsh-agent"]) {
    assert.throws(() => require.resolve(host), { code: "MODULE_NOT_FOUND" });
  }
  const packed = join(consumer, "node_modules/personal-bot");
  const version = execFileSync(process.execPath, [join(packed, "bin/pbot.mjs"), "--version"],
    { cwd: workspace, env, encoding: "utf8" }).trim();
  assert.equal(version, source.version);

  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund",
    `@earendil-works/pi-coding-agent@${source.devDependencies["@earendil-works/pi-coding-agent"]}`]);
  // Run the real Pi SDK with an isolated home and no model credentials.
  const driver = join(consumer, "verify.mjs");
  await writeFile(driver, `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const [workspace, agentDir, packed] = process.argv.slice(2);
await mkdir(agentDir);
const plan = JSON.parse(execFileSync("python3", ["-I", "-B", join(packed, "scripts/setup-python.py"), "--check"], { encoding: "utf8" }));
await mkdir(plan.directory, { recursive: true });
await writeFile(join(plan.directory, "keep"), "unrelated test data");
const settingsManager = SettingsManager.inMemory({ packages: [packed] });
const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const { session } = await createAgentSession({ cwd: workspace, agentDir, settingsManager, resourceLoader: loader,
  modelRuntime, model: modelRuntime.getModels("openai-codex")[0], sessionManager: SessionManager.inMemory(workspace) });
const errors = [];
try {
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  assert.ok(loader.getSkills().skills.length > 0);
  assert.deepEqual(session.getAllTools().map(tool => tool.name).filter(name => name.startsWith("pbot_")).sort(),
    ["pbot_agent", "pbot_history", "pbot_team", "pbot_team_message"]);
  await session.prompt("/pbot init");
  assert.ok((await readdir(workspace)).includes("AGENTS.md"));
  assert.equal(session.messages.length, 0);
  assert.deepEqual(errors, []);
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
console.log("Packed Pi extension, skills, tools and initialization passed without a model request.");
`);
  execFileSync(process.execPath, [driver, workspace, join(root, "agent"), packed],
    { cwd: workspace, env, stdio: "inherit", timeout: 30_000 });
  console.log(`Consumer acceptance passed: personal-bot@${version}, Node ${process.version}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
