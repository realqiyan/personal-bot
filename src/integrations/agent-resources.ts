import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";
import type { HostId, WorkspaceContext, WorkspaceRole } from "../model/plugin-host.js";

export async function readOptionalFile(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function readLocalRole(agent: WorkspaceRole, root: string): Promise<string> {
  const local = await readOptionalFile(join(root, "agents", agent + ".md"));
  return local.trim() ? "工作区职责补充：\n" + local : "";
}

export async function agentText(
  agent: WorkspaceRole,
  root: string,
  coordinatorPrompt = "plugin-coordinator.md",
): Promise<string> {
  requireThat(agent === "coordinator" || agent === "general-purpose", "未知职责。");
  let text = await readFile(join(resourceRoot, "agents", agent + ".md"), "utf8");
  if (agent === "coordinator") {
    text += "\n\n" + await readFile(join(resourceRoot, "prompts", coordinatorPrompt), "utf8");
  }
  const local = await readLocalRole(agent, root);
  if (local) text += "\n\n" + local;
  requireThat(text.trim(), "专家职责为空。");
  return text;
}

export async function loadWorkspaceContext(options: {
  host: HostId;
  root: string;
  role: WorkspaceRole;
  coordinatorPrompt?: string;
  includeRootAgents?: boolean;
  localRoleOnly?: boolean;
}): Promise<WorkspaceContext> {
  const { host, root, role, coordinatorPrompt, includeRootAgents = false, localRoleOnly = false } = options;
  const [workspace, roleText, rootAgents] = await Promise.all([
    readFile(join(resourceRoot, "prompts/workspace.md"), "utf8"),
    localRoleOnly ? readLocalRole(role, root) : agentText(role, root, coordinatorPrompt),
    includeRootAgents ? readOptionalFile(join(root, "AGENTS.md")) : Promise.resolve(""),
  ]);
  const environment = { host, workspaceRoot: root, resourceRoot };
  const text = [
    workspace,
    roleText,
    rootAgents,
    "## 环境\n\n" + JSON.stringify(environment),
  ].filter(Boolean).join("\n\n");
  return { workspace, role: roleText, rootAgents, environment, text };
}
