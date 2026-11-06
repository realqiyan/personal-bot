import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
export const pythonExecutable = (await exec("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"])).stdout.trim();

/** Ask the real setup script where this isolated user would install, then occupy it with unrelated data. */
export async function preparePythonFailure(root) {
  const environment = { HOME: root, XDG_DATA_HOME: join(root, "data") };
  const { stdout } = await exec(pythonExecutable, ["-I", "-B", resolve("scripts/setup-python.py"), "--check"],
    { env: { ...process.env, ...environment } });
  const directory = JSON.parse(stdout).directory, local = relative(root, directory);
  assert.ok(local && local !== ".." && !local.startsWith("../") && !isAbsolute(local), "Python fixture must stay in its temporary user home");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "keep"), "unrelated data");
  return { directory, environment };
}
