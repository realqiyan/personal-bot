import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireThat } from "../../common/validation.js";
import { resourceRoot } from "../../common/paths.js";

export const directories = ["areas", "projects", "knowledge", "providers", "scratch", "agents"];
export async function prepareWorkspace(root: string) {
  for (const part of directories) {
    const path = join(root, part);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const entry = await lstat(path);
    requireThat(entry.isDirectory() && !entry.isSymbolicLink(), "工作区目录不能使用符号链接：" + path);
  }
  const agents = await readFile(join(resourceRoot, "templates/workspace-agents.md"), "utf8");
  await writeFile(join(root, "AGENTS.md"), agents, { flag: "wx" })
    .catch(error => { if (error.code !== "EEXIST") throw error; });
}
