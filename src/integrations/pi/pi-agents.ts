import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { requireThat } from "../../common/validation.js";
import type { AgentDescriptor } from "../../model/agent.js";
import type { AgentHost } from "../../services/agents/agent-service.js";

export const agentDirectory = () => join(getAgentDir(), "pbot/subagents");
export const tmuxName = (id: string) => "pbot-" + id;
export class PiAgents implements AgentHost {
  available() {
    requireThat(spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0, "子会话需要 tmux。");
    requireThat(existsSync(join(getPackageDir(), "dist/cli.js")), "无法定位 Pi CLI。");
  }
  alive(id: string) { return spawnSync("tmux", ["has-session", "-t", "=" + tmuxName(id)], { stdio: "ignore" }).status === 0; }
  kill(id: string) { spawnSync("tmux", ["kill-session", "-t", "=" + tmuxName(id)], { stdio: "ignore" }); }
  launch(d: AgentDescriptor, directory: string, generation: string) {
    const o = d.options;
    const entry = fileURLToPath(new URL("../../extension/subagent-entry.ts", import.meta.url));
    const compiled = fileURLToPath(new URL("../../extension/subagent-entry.js", import.meta.url));
    const args = ["--session", join(directory, "session.jsonl"), "--extension", existsSync(entry) ? entry : compiled];
    if (o.noExtensions !== false) args.push("--no-extensions",
      "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", "builtin:tool-search");
    if (o.noSkills) args.push("--no-skills");
    if (o.noPromptTemplates) args.push("--no-prompt-templates");
    if (o.noContextFiles) args.push("--no-context-files");
    // Resume restores native model choices. Explicit model options apply only to a new transcript.
    if (!existsSync(join(directory, "session.jsonl"))) {
      args.push("--provider", o.provider!, "--model", o.model!);
      if (o.thinking) args.push("--thinking", o.thinking);
    }
    if (o.tools) args.push("--tools", o.tools.join(","));
    const result = spawnSync("tmux", ["new-session", "-d", "-s", tmuxName(d.agentId), "-x", "120", "-y", "40", "-c", d.cwd, "--",
      "env", `PBOT_SUBAGENT_RUN_ID=${d.agentId}`, `PBOT_SUBAGENT_DIR=${directory}`, `PBOT_SUBAGENT_GENERATION=${generation}`,
      `PI_CODING_AGENT_DIR=${getAgentDir()}`,
      ...["PATH", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"].flatMap(key => process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`]),
      process.execPath, join(getPackageDir(), "dist/cli.js"), ...args], { encoding: "utf8" });
    requireThat(result.status === 0, result.stderr || "子会话启动失败。");
  }
  report(file: string, leaf: string | null) {
    if (!leaf || !existsSync(file)) return "";
    const manager = SessionManager.open(file);
    requireThat(manager.getEntry(leaf), "报告叶节点不存在。");
    const last = manager.getBranch(leaf).filter(e => e.type === "message" && e.message.role === "assistant").at(-1);
    return last?.type === "message" && last.message.role === "assistant"
      ? last.message.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
  }
}
