import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir, getPackageDir, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { requireThat } from "../../common/validation.js";
import type { AgentDescriptor } from "../../model/agent.js";
import type { AgentHost } from "../../services/agents/agent-service.js";

export const agentDirectory = () => join(getAgentDir(), "pbot/subagents");
export const tmuxName = (id: string) => "pbot-" + id;
// Read through the native parser and tree without opening a writable manager or migrating files.
export function readAgentSession(d: AgentDescriptor, file: string, strict = false) {
  requireThat(lstatSync(file).isFile(), "原生会话必须是普通文件。");
  const content = readFileSync(file, "utf8"), entries = parseSessionEntries(content), header = entries[0];
  // Report reads can race an append after their fixed leaf. Resume must not discard malformed history.
  if (strict) requireThat(entries.length === content.split("\n").filter(line => line.trim()).length, "原生会话包含无效记录。");
  requireThat(header?.type === "session" && header.version === CURRENT_SESSION_VERSION &&
    header.id === d.agentId && header.cwd === d.cwd, "原生会话身份或工作目录不匹配。");
  return SessionManager.inMemory(d.cwd, undefined, entries);
}

export class PiAgents implements AgentHost {
  available() {
    requireThat(spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0, "子会话需要 tmux。");
    requireThat(existsSync(join(getPackageDir(), "dist/cli.js")), "无法定位 Pi CLI。");
  }
  alive(id: string) { return spawnSync("tmux", ["has-session", "-t", "=" + tmuxName(id)], { stdio: "ignore" }).status === 0; }
  kill(id: string) { spawnSync("tmux", ["kill-session", "-t", "=" + tmuxName(id)], { stdio: "ignore" }); }
  validateSession(d: AgentDescriptor, file: string) { readAgentSession(d, file, true); }
  launch(d: AgentDescriptor, directory: string, generation: string, sessionFile: string | null) {
    if (sessionFile !== null) this.validateSession(d, sessionFile);
    const o = d.options;
    const entry = fileURLToPath(new URL("../../extension/subagent-entry.ts", import.meta.url));
    const compiled = fileURLToPath(new URL("../../extension/subagent-entry.js", import.meta.url));
    const args = [...(sessionFile === null ? ["--session-id", d.agentId] : ["--session", sessionFile]),
      "--extension", existsSync(entry) ? entry : compiled];
    if (o.noExtensions !== false) args.push("--no-extensions",
      "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", "builtin:tool-search");
    if (o.noSkills) args.push("--no-skills");
    if (o.noPromptTemplates) args.push("--no-prompt-templates");
    if (o.noContextFiles) args.push("--no-context-files");
    // Resume restores native model choices. Explicit model options apply only to a new transcript.
    if (sessionFile === null) {
      args.push("--provider", o.provider!, "--model", o.model!);
      if (o.thinking) args.push("--thinking", o.thinking);
    }
    if (o.tools) args.push("--tools", o.tools.join(","));
    const result = spawnSync("tmux", ["new-session", "-d", "-s", tmuxName(d.agentId), "-x", "120", "-y", "40", "-c", d.cwd, "--",
      "env", `PBOT_SUBAGENT_RUN_ID=${d.agentId}`, `PBOT_SUBAGENT_DIR=${directory}`, `PBOT_SUBAGENT_GENERATION=${generation}`,
      `PI_CODING_AGENT_DIR=${getAgentDir()}`, `PI_CODING_AGENT_SESSION_DIR=${process.env.PI_CODING_AGENT_SESSION_DIR ?? ""}`,
      ...["PATH", "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"].flatMap(key => process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`]),
      process.execPath, join(getPackageDir(), "dist/cli.js"), ...args], { encoding: "utf8" });
    requireThat(result.status === 0, result.stderr || "子会话启动失败。");
  }
  report(d: AgentDescriptor, file: string, leaf: string) {
    const manager = readAgentSession(d, file);
    requireThat(manager.getEntry(leaf), "报告叶节点不存在。");
    const last = manager.getBranch(leaf).filter(e => e.type === "message" && e.message.role === "assistant").at(-1);
    return last?.type === "message" && last.message.role === "assistant"
      ? last.message.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
  }
}
