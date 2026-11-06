import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Bash from "@deepseek-ai/dsh-bash-local";
import { activatePython } from "../../dist/integrations/python-activation.js";

const exec = promisify(execFile);

test("native dsh Bash reads the process venv at spawn and preserves each workspace cwd", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot dsh python ")));
  const directory = join(root, "venv"), ctx = new Context();
  let restore;
  const keys = ["PATH", "VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "PYTHONNOUSERSITE"];
  const before = keys.map(key => process.env[key]);
  try {
    await exec("/usr/bin/python3", ["-m", "venv", "--without-pip", directory]);
    await ctx.plugin(Subprocess);
    await ctx.plugin(Bash);
    restore = activatePython(directory);
    for (const workspace of ["a", "b"]) {
      const cwd = join(root, workspace);
      await mkdir(cwd);
      const spec = ctx.shell.resolve({ workdir: cwd,
        command: "python -c 'import json,os,site,sys; print(json.dumps([sys.prefix,os.environ.get(\"VIRTUAL_ENV\"),os.getcwd(),site.ENABLE_USER_SITE,17+25]))'" });
      const execution = await ctx.shell.execute(spec);
      const result = await execution.result();
      assert.equal(result.exitCode, 0, result.stderr.text);
      assert.deepEqual(JSON.parse(result.stdout.text), [directory, directory, cwd, false, 42]);
    }
  } finally {
    await ctx.fiber.dispose();
    restore?.();
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(keys.map(key => process.env[key]), before);
});
