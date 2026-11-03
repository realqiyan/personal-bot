import { stat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export async function resolveWorkspace(value: string, cwd: string, home: string): Promise<string> {
  const path = resolve(cwd, value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
  let existing = path;
  while (true) {
    try {
      if (!(await stat(existing)).isDirectory()) throw new Error("工作区或其父路径不是目录：" + existing);
      return resolve(await realpath(existing), relative(existing, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}
