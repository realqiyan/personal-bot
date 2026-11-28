import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceRoot } from "../common/paths.js";
import { requireThat } from "../common/validation.js";
import type { HostId, WorkspaceContext, WorkspaceRole } from "../model/plugin-host.js";
import type { WorkspaceSkillMeta } from "../model/workspace-mcp.js";

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

export function formatWorkspaceSkills(skills: readonly WorkspaceSkillMeta[]): string {
  if (!skills.length) return "";
  const lines = skills.map(skill => `- **${skill.name}**（\`${skill.path}\`）：${skill.description}`);
  return "## 可用技能\n\n任务匹配时按需读取对应 `SKILL.md` 正文：\n" + lines.join("\n");
}

export async function loadWorkspaceContext(options: {
  host: HostId;
  root: string;
  role: WorkspaceRole;
  coordinatorPrompt?: string;
  includePrompts?: boolean;
  includeRootAgents?: boolean;
  localRoleOnly?: boolean;
  workspaceSkills?: readonly WorkspaceSkillMeta[];
  notices?: readonly string[];
}): Promise<WorkspaceContext> {
  const {
    host,
    root,
    role,
    coordinatorPrompt,
    includePrompts = true,
    includeRootAgents = false,
    localRoleOnly = false,
    workspaceSkills = [],
    notices = [],
  } = options;
  const [workspace, roleText, rootAgents] = includePrompts
    ? await Promise.all([
      readFile(join(resourceRoot, "prompts/workspace.md"), "utf8"),
      localRoleOnly ? readLocalRole(role, root) : agentText(role, root, coordinatorPrompt),
      includeRootAgents ? readOptionalFile(join(root, "AGENTS.md")) : Promise.resolve(""),
    ])
    : ["", "", ""];
  const skillsSection = formatWorkspaceSkills(workspaceSkills);
  const noticesSection = notices.length
    ? "## 启动提示\n\n以下为工作区维护提醒，适时顺带告知用户即可，勿未经用户要求自行执行：\n" + notices.map(item => `- ${item}`).join("\n")
    : "";
  const environment = { host, workspaceRoot: root, resourceRoot };
  const text = [
    workspace,
    roleText,
    rootAgents,
    skillsSection,
    noticesSection,
    "## 环境\n\n" + JSON.stringify(environment),
  ].filter(Boolean).join("\n\n");
  return { workspace, role: roleText, rootAgents, workspaceSkills: [...workspaceSkills], environment, text };
}
