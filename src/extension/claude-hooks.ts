import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { object } from "../common/json.js";
import { resourceRoot } from "../common/paths.js";
import { packageVersion } from "../common/version.js";
import { requireThat } from "../common/validation.js";
import { agentText } from "../integrations/agent-resources.js";
import { PythonEnvironmentService } from "../services/workspace/python-environment-service.js";
import { readWorkspaceConfig } from "../services/workspace/workspace-config.js";
import { initializeWorkspace } from "../services/workspace/workspace-preparation.js";

export async function claudeWorkspaceRoot(cwd: string, projectDirectory = process.env.CLAUDE_PROJECT_DIR): Promise<string> {
  const directory = projectDirectory || cwd;
  requireThat(isAbsolute(directory), "Claude 工作区需要绝对路径。");
  const root = await realpath(directory);
  requireThat((await stat(root)).isDirectory(), "Claude 工作区需要目录。");
  return root;
}

async function pythonStatus(root: string, prepare: boolean, force = false) {
  const python = new PythonEnvironmentService(root);
  try {
    if (force) await python.setup();
    else {
      const current = await python.inspect();
      if (prepare && current.state === "unprepared") await python.setup();
    }
  } catch { /* The service retains the preparation or inspection error for status. */ }
  finally { await python.close(); }
  const status = python.status;
  return { ...status, ...(status.state === "ready" ? { executable: join(status.directory!, "bin/python") } : {}) };
}

function disabled(configuration: Awaited<ReturnType<typeof readWorkspaceConfig>>) {
  return configuration.error ?? "Personal Bot 未在此工作区启用。运行 /personal-bot:pbot init；配置文件：" + configuration.path;
}

export async function claudeCommand(args: readonly string[], cwd: string) {
  const root = await claudeWorkspaceRoot(cwd);
  const action = args.join(" ");
  requireThat(["init", "status", "python setup"].includes(action), "用法：node <插件目录>/lib/claude.js init|status|python setup");
  if (action === "init") await initializeWorkspace(root);
  const configuration = await readWorkspaceConfig(root);
  if (action === "python setup") requireThat(configuration.enabled, disabled(configuration));
  return { version: packageVersion, workspaceRoot: root, resourceRoot, configuration,
    python: configuration.enabled ? await pythonStatus(root, action !== "status", action === "python setup") : { state: "unprepared" as const } };
}

/** Standard command hooks consume documented stdin fields; native sessions remain entirely host-owned. */
export async function claudeHook(value: unknown): Promise<Record<string, unknown>> {
  requireThat(object(value) && typeof value.hook_event_name === "string", "Claude hook 输入无效。");
  if (process.env.PBOT_SUBAGENT_RUN_ID) return {};
  const event = value.hook_event_name;
  requireThat(["SessionStart", "UserPromptSubmit", "SubagentStart", "PreToolUse", "UserPromptExpansion"].includes(event), "Claude hook 事件未支持。");
  const skillCheck = event === "PreToolUse" || event === "UserPromptExpansion";
  if (skillCheck) {
    const skill = event === "UserPromptExpansion"
      ? value.expansion_type === "slash_command" ? value.command_name : undefined
      : value.tool_name === "Skill" && object(value.tool_input) ? value.tool_input.skill : undefined;
    if (typeof skill !== "string" || !skill.startsWith("personal-bot:") || skill === "personal-bot:pbot") return {};
  }
  requireThat(typeof value.cwd === "string", "Claude hook 缺少工作目录。");
  const root = await claudeWorkspaceRoot(value.cwd);
  const configuration = await readWorkspaceConfig(root);
  if (skillCheck) {
    if (configuration.enabled) return {};
    return event === "UserPromptExpansion" ? { decision: "block", reason: disabled(configuration) } : { hookSpecificOutput: {
      hookEventName: event, permissionDecision: "deny", permissionDecisionReason: disabled(configuration),
    } };
  }
  if (!configuration.enabled) return event === "SubagentStart" ? {} : {
    hookSpecificOutput: { hookEventName: event, additionalContext: disabled(configuration) },
  };
  if (event === "SubagentStart" && value.agent_type !== "personal-bot:general-purpose") return {};
  const python = await pythonStatus(root, event === "SessionStart" || event === "UserPromptSubmit");
  if (event === "SessionStart") return python.state === "error" ? { systemMessage: python.error } : {};
  const member = event === "SubagentStart" || typeof value.agent_id === "string";
  const role = event === "SubagentStart" ? readFile(join(root, "agents/general-purpose.md"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }) : agentText(member ? "general-purpose" : "coordinator", root, "claude");
  const [workspace, duties, agents] = await Promise.all([
    readFile(join(resourceRoot, "prompts/workspace.md"), "utf8"),
    role,
    readFile(join(root, "AGENTS.md"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }),
  ]);
  return { ...(python.state === "error" ? { systemMessage: python.error } : {}),
    hookSpecificOutput: { hookEventName: event, additionalContext: [
      workspace, duties, agents, JSON.stringify({ workspaceRoot: root, resourceRoot, python }),
    ].filter(Boolean).join("\n\n") } };
}
