import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceRoot } from "../../common/paths.js";
import { requireThat } from "../../common/validation.js";

export async function agentText(agent: "coordinator" | "general-purpose", root: string) {
  requireThat(agent === "coordinator" || agent === "general-purpose", "未知职责。");
  let text = await readFile(join(resourceRoot, "agents", agent + ".md"), "utf8");
  try {
    const local = await readFile(join(root, "agents", agent + ".md"), "utf8");
    text += "\n\n工作区职责补充：\n" + local;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  requireThat(text.trim(), "专家职责为空。");
  return text;
}
