import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { searchWorkspaceHistory } from "../../dist/services/history/history-query.js";
import { inspectWorkspaceSummaries, runWorkspaceSummaries } from "../../dist/services/history/summary-runner.js";

const exec = promisify(execFile);
const claudeEntry = resolve("dist/claude.js");
const agyBundle = resolve("lib/antigravity-plugin");

class McpClient {
  #nextId = 1;
  #pending = new Map();
  #buffer = "";
  constructor(child) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.#buffer += chunk;
      for (;;) {
        const nl = this.#buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        const resolver = this.#pending.get(msg.id);
        if (resolver) {
          this.#pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
  }
  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("MCP request timeout: " + method));
      }, 25_000);
      this.#pending.set(id, response => { clearTimeout(timer); resolveResponse(response); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return {
      isError: Boolean(response.result.isError),
      text: response.result.content[0].text,
      data: response.result.isError ? undefined : JSON.parse(response.result.content[0].text),
    };
  }
  async close() {
    this.child.stdin.end();
    await new Promise(resolveExit => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolveExit(); }, 5000);
      this.child.once("close", () => { clearTimeout(timer); resolveExit(); });
    });
  }
}

test("Claude and Antigravity hooks record raw history, Pi summarizes cross-host archives, and MCP queries them read-only", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-plugin-history-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const pluginDir = join(root, "agy-plugin");
  const controlDir = join(root, "subagents");
  const logsDir = join(root, "agy-logs");
  await Promise.all([
    mkdir(join(workspace, ".pbot"), { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    cp(agyBundle, pluginDir, { recursive: true }),
  ]);
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true }));

  const env = { PATH: process.env.PATH, HOME: join(root, "home"), CLAUDE_PROJECT_DIR: workspace, PLUGIN_ROOT: pluginDir };
  const claudeHook = async (hook_event_name, values = {}) => {
    const child = exec(process.execPath, [claudeEntry, "hook"], { cwd: workspace, env, timeout: 30_000 });
    child.child.stdin.end(JSON.stringify({ hook_event_name, cwd: workspace, ...values }));
    return JSON.parse((await child).stdout);
  };
  const agyHook = async (hookEventName, values = {}) => {
    const child = exec(process.execPath, [join(pluginDir, "lib/plugin.js"), "antigravity", "hook"], { cwd: pluginDir, env, timeout: 30_000 });
    child.child.stdin.end(JSON.stringify({ hookEventName, workspacePaths: [workspace], cwd: workspace, ...values }));
    return JSON.parse((await child).stdout);
  };

  // 1. Claude Code records 4 turns via UserPromptSubmit + Stop (and updates continuation without duplicating).
  for (let i = 1; i <= 4; i++) {
    await claudeHook("UserPromptSubmit", { session_id: "claude-sess-1", prompt: `Claude 问题 ${i}` });
    await claudeHook("Stop", { session_id: "claude-sess-1", last_assistant_message: `Claude 答复 ${i}` });
  }
  await claudeHook("Stop", { session_id: "claude-sess-1", last_assistant_message: "Claude 续跑最终答复 4", stop_hook_active: true });
  // Native subagent bearing agent_id must be ignored.
  await claudeHook("UserPromptSubmit", { session_id: "claude-sub-1", agent_id: "sub-1", prompt: "不应记录的子代理问题" });
  await claudeHook("Stop", { session_id: "claude-sub-1", agent_id: "sub-1", last_assistant_message: "不应记录的子代理答复" });

  // 2. Antigravity Stop hook reads transcript_full.jsonl (falling back from truncated transcript.jsonl).
  const transcriptPath = join(logsDir, "transcript.jsonl");
  const fullPath = join(logsDir, "transcript_full.jsonl");
  const transcriptLines = [];
  for (let i = 1; i <= 4; i++) {
    const base = (i - 1) * 3;
    transcriptLines.push(JSON.stringify({
      step_index: base,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: `2026-11-27T10:0${i}:00Z`,
      content: `<USER_REQUEST>\nAntigravity 问题 ${i}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>`,
    }));
    transcriptLines.push(JSON.stringify({
      step_index: base + 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: `2026-11-27T10:0${i}:05Z`,
      content: "中间思考调用工具",
      tool_calls: [{ name: "read_file", args: { Path: "a.txt" } }],
    }));
    transcriptLines.push(JSON.stringify({
      step_index: base + 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: `2026-11-27T10:0${i}:10Z`,
      content: `Antigravity 完整答复 ${i}`,
    }));
  }
  await writeFile(transcriptPath, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "truncated" }) + "\n");
  await writeFile(fullPath, transcriptLines.join("\n") + "\n");
  assert.deepEqual(await agyHook("Stop", { conversationId: "agy-conv-1", transcriptPath, terminationReason: "NO_TOOL_CALL" }), {});
  // Re-running Stop on the same transcript is idempotent.
  assert.deepEqual(await agyHook("Stop", { conversationId: "agy-conv-1", transcriptPath, terminationReason: "NO_TOOL_CALL" }), {});

  const rawFiles = await readdir(join(workspace, ".pbot/history/raw"));
  assert.equal(rawFiles.filter(name => name.startsWith("claude-")).length, 1);
  assert.equal(rawFiles.filter(name => name.startsWith("antigravity-")).length, 1);

  // 3. Explicit summary runner discovers both Claude & Antigravity raw archives and generates session summaries.
  assert.equal(searchWorkspaceHistory(workspace, { host: "claude" }).total, 1);
  assert.equal(searchWorkspaceHistory(workspace, { host: "antigravity" }).total, 1);
  assert.equal(searchWorkspaceHistory(workspace, { query: "Claude 续跑最终答复 4" }).total, 1);
  assert.equal(searchWorkspaceHistory(workspace, { query: "Antigravity 完整答复 4" }).total, 1);
  assert.equal(searchWorkspaceHistory(workspace, { query: "不应记录" }).total, 0);
  assert.equal(searchWorkspaceHistory(workspace, { query: "中间思考调用工具" }).total, 0);

  const beforeStatus = inspectWorkspaceSummaries(workspace);
  assert.equal(beforeStatus.rawCount, 2);
  assert.equal(beforeStatus.dimensions[0].pendingCreate, 2);

  const runReport = await runWorkspaceSummaries({
    root: workspace,
    summarizer: async ({ prompt }) => prompt.includes("Claude") ? "Claude 四轮汇总摘要" : "Antigravity 四轮汇总摘要",
  });
  assert.equal(runReport.dimensions[0].created, 2);
  assert.equal(runReport.dimensions[0].skipped, 0);
  assert.equal(inspectWorkspaceSummaries(workspace).dimensions[0].ready, 2);
  assert.equal(searchWorkspaceHistory(workspace, { query: "Claude 四轮汇总摘要" }).total, 1);
  assert.equal(searchWorkspaceHistory(workspace, { query: "Antigravity 四轮汇总摘要" }).total, 1);

  // 4. Standalone MCP server exposes read-only history_search & history_read across all hosts.
  const child = spawn(process.execPath, [join(pluginDir, "lib/extension/mcp.js")], {
    cwd: pluginDir,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), PBOT_MCP_AGENT_DIR: controlDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcp = new McpClient(child);
  t.after(() => mcp.close());
  await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });

  const allSessions = await mcp.call("history_search", { workspace });
  assert.equal(allSessions.isError, false, allSessions.text);
  assert.equal(allSessions.data.total, 2);

  const agySummaryHit = await mcp.call("history_search", { workspace, host: "antigravity", query: "Antigravity 四轮汇总摘要" });
  assert.equal(agySummaryHit.isError, false, agySummaryHit.text);
  assert.equal(agySummaryHit.data.total, 1);
  const summaryNode = await mcp.call("history_read", { workspace, id: agySummaryHit.data.matches[0].id, host: "antigravity" });
  assert.equal(summaryNode.isError, false, summaryNode.text);
  assert.equal(summaryNode.data.node.kind, "summary");
  assert.equal(summaryNode.data.node.children.length, 4);

  // 5. features.history: false disables both plugin hook recording and MCP history queries.
  await writeFile(join(workspace, ".pbot/config.json"), JSON.stringify({ enabled: true, features: { history: false } }));
  await claudeHook("UserPromptSubmit", { session_id: "claude-disabled", prompt: "关闭历史后的问题" });
  await claudeHook("Stop", { session_id: "claude-disabled", last_assistant_message: "关闭历史后的答复" });
  const denied = await mcp.call("history_search", { workspace });
  assert.equal(denied.isError, true);
  assert.ok(denied.text.includes("features.history"));
  const rawAfterDisable = await readdir(join(workspace, ".pbot/history/raw"));
  assert.equal(rawAfterDisable.length, 2);
});
