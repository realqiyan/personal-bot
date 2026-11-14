import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AgentFiles, descriptor, launch } from "../storage/agent-files.js";
import { acpInput, acpAnswer } from "../storage/acp-files.js";
import type { AcpInput, AcpAnswer } from "../model/acp.js";
import { requireThat } from "../common/validation.js";
import { resourceRoot } from "../common/paths.js";
import { packageVersion, releaseLine } from "../common/version.js";
import { agentText } from "../integrations/agent-resources.js";
import { readWorkspaceConfig, workspaceDisabledMessage } from "../services/workspace/workspace-config.js";

export async function acpMember() {
  const id = process.env.PBOT_SUBAGENT_RUN_ID, directory = process.env.PBOT_SUBAGENT_DIR, generation = process.env.PBOT_SUBAGENT_GENERATION;
  requireThat(id && directory && generation, "缺少 ACP 成员启动身份。");
  const files = new AgentFiles(dirname(realpathSync(directory)));
  requireThat(files.directory(id) === realpathSync(directory), "ACP 成员目录不匹配。");
  const d = files.read(id, "descriptor.json", descriptor);
  requireThat(d.agentId === id && releaseLine(d.release) === releaseLine(packageVersion), "ACP 成员身份或版本无效。");
  const configuration = await readWorkspaceConfig(d.workspace);
  requireThat(configuration.enabled, workspaceDisabledMessage(configuration));
  const check = () => {
    files.check();
    const run = files.read(id, "launch.json", launch);
    requireThat(run.generation === generation && (!run.stop || process.env.PBOT_ACP_VALIDATE === "1"), "ACP 成员已停止或启动代次变化。");
  };
  const context = async () => {
    const [workspace, role] = await Promise.all([readFile(join(resourceRoot, "prompts/workspace.md"), "utf8"), agentText("general-purpose", d.workspace)]);
    const state = process.env.PBOT_ACP_PYTHON_STATE ?? "unavailable";
    const python = state === "ready" && process.env.VIRTUAL_ENV ? { state, directory: process.env.VIRTUAL_ENV } : { state };
    return { workspace, role, environment: JSON.stringify({ workspaceRoot: d.workspace, resourceRoot, python }) };
  };
  return { files, d, id, generation, check, context,
    input() {
      check(); const input = files.read(id, "acp-input.json", acpInput);
      requireThat(input.generation === generation, "ACP 输入代次无效。"); return input;
    },
    answer(input: AcpInput, state: AcpAnswer["state"], answer: string, error?: string) {
      // A stop can race the native terminal event. The current generation may still seal its result.
      if (files.read(id, "launch.json", launch).generation !== generation) return;
      files.write(id, "acp-answer.json", { ...input, state, answer, ...(error ? { error } : {}) }, acpAnswer);
    },
  };
}
