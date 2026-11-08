import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProfile } from "@deepseek-ai/dsh-app-boot";

const tarball = resolve(process.argv[2]);
const cli = fileURLToPath(new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pbot-dsh-consumer-"));
const home = join(root, "home"), dshHome = join(root, "dsh"), workspace = join(root, "workspace");
const profile = join(dshHome, "profiles/pbot-consumer");
await Promise.all([home, workspace].map(path => mkdir(path)));
const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, "data"),
  DSH_HOME: dshHome, LANG: "C.UTF-8", CI: "true" };
const dsh = args => execFileSync(process.execPath, [cli, ...args], {
  cwd: workspace, env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
});
try {
  initProfile(profile, []);
  dsh(["plugin", "--profile", "pbot-consumer", "add", tarball]);

  // Resolve from the installed package, outside the repository and its development dependencies.
  const packed = join(profile, "node_modules/personal-bot");
  const require = createRequire(join(packed, "package.json"));
  for (const host of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.throws(() => require.resolve(host), { code: "MODULE_NOT_FOUND" });
  }
  const manifest = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  const version = execFileSync(process.execPath, [join(packed, "bin/pbot.mjs"), "--version"],
    { cwd: workspace, env, encoding: "utf8" }).trim();
  assert.equal(version, manifest.version);

  // The native schema collector imports the Host entry without mounting plugins or starting Python/model work.
  const dump = JSON.parse(dsh(["--profile", "pbot-consumer", "--dump-config-schema"]));
  const entries = dump["x-cordis"].entries.filter(entry => entry.name === "personal-bot");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "absent");
  assert.equal(dump["x-cordis"].complete, true);
  console.log(`Packed dsh Host imports passed without installed TypeBox or host SDK copies: personal-bot@${version}, Node ${process.version}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
