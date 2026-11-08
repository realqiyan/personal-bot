import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";
import { preparePythonFailure } from "../helpers/python-home.mjs";

for (const { name, noSkills = false, globalSkills, projectPackages, expected } of [
  { name: "enabled", expected: ["skill:project-maintenance", "skill:provider-connections"] },
  { name: "--no-skills", noSkills: true, expected: [] },
  { name: "global filter with project packages", globalSkills: [], projectPackages: [], expected: [] },
  { name: "project delta over a global filter", globalSkills: [],
    projectPackages: [{ source: resolve("."), autoload: false, skills: ["+resources/skills/provider-connections"] }],
    expected: ["skill:provider-connections"] },
]) test("real Pi CLI applies native skill settings: " + name, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pbot-cli-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), agentDir = join(root, "agent"), output = join(root, "observed.json");
  await mkdir(workspace); await mkdir(agentDir);
  const { environment } = await preparePythonFailure(join(root, "home"));
  await initializeWorkspaceConfig(workspace);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProjectTrust: "always",
    packages: [globalSkills === undefined ? resolve(".") : { source: resolve("."), skills: globalSkills }],
  }));
  if (projectPackages !== undefined) {
    await mkdir(join(workspace, ".pi"));
    await writeFile(join(workspace, ".pi/settings.json"), JSON.stringify({ packages: projectPackages }));
  }
  const probe = join(root, "probe.mjs");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
export default function(pi) {
  pi.registerCommand("pbot-probe", { description: "Inspect native resource metadata", handler: async (_args, ctx) => {
    const prefix = ${JSON.stringify(resolve("resources/skills") + "/")};
    const skills = pi.getCommands().filter(command => command.source === "skill" && command.sourceInfo.path.startsWith(prefix));
    await writeFile(${JSON.stringify(output)}, JSON.stringify({
      skills: skills.map(command => command.name).sort(),
      tools: pi.getAllTools().filter(tool => tool.name.startsWith("pbot_")).map(tool => tool.name).sort(),
      assistantMessages: ctx.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant").length,
    }));
    ctx.shutdown();
  } });
}
`);
  const child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--mode", "json", "--print", "--no-session", "--provider", "openai", "--model", "gpt-4.1",
    ...(noSkills ? ["--no-skills"] : []), "--extension", probe, "/pbot-probe"], {
    cwd: workspace, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(20000),
    env: { PATH: process.env.PATH, ...environment, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", LANG: "C.UTF-8" },
  });
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", text => { diagnostic = (diagnostic + text).slice(-16000); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, diagnostic);
  const observed = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(observed.skills, expected);
  assert.deepEqual(observed.tools, ["pbot_agent", "pbot_history", "pbot_team", "pbot_team_message"]);
  assert.equal(observed.assistantMessages, 0);
});
