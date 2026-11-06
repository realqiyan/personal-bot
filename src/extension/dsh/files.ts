import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution, ToolExecutionToken } from "@deepseek-ai/dsh-tools";
import { parsePatch } from "@deepseek-ai/dsh-fs-patch";
import type {} from "@deepseek-ai/dsh-user-approval";
import { object } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";
import { mutationScope } from "../../services/workspace/workspace-files.js";

/** Native filesystem mutations share the original workspace's confirmation rule.
 * This does not confine Bash, Python, MCP, or other extensions. */
export function registerDshFileEvents(ctx: Context, agent: Agent, root: string, expert: boolean, check: () => void) {
  const lifetime = new AbortController();
  const mutations = new Set(["write", "edit", "apply_patch"]);
  const captured = new Map<ToolExecutionToken, { cwd: string; keys: string[]; approved: boolean }>();
  ctx.effect(() => () => { lifetime.abort(); captured.clear(); });
  async function targets(exec: Readonly<ToolExecution>) {
    check(); const args = exec.arguments;
    requireThat(exec.agent === agent && object(args), "文件操作会话或参数无效。");
    const signal = AbortSignal.any([lifetime.signal, exec.signal]); signal.throwIfAborted();
    let paths: string[];
    if (exec.name === "apply_patch") {
      requireThat(typeof args.input === "string", "补丁参数无效。");
      paths = parsePatch(args.input).flatMap(operation => [operation.path, ...(operation.kind === "update" && operation.moveTo ? [operation.moveTo] : [])]);
    } else {
      requireThat(typeof args.file_path === "string" && args.file_path.trim().length > 0, "文件路径无效。");
      paths = [args.file_path];
    }
    const anchor = ctx.fs.processPathFromHostPath(root);
    requireThat(anchor !== undefined, "原生文件系统未映射当前工作区。");
    const cwd = ctx.workingDirectory.get(agent.session);
    const resolved = await Promise.all(paths.map(path => ctx.fs.resolve(path, { cwd, signal })));
    signal.throwIfAborted(); check();
    const outside = resolved.map(target => ctx.fs.processPath(target)).filter(path => mutationScope(anchor, path) === "outside");
    return { cwd, keys: resolved.map(target => target.targetKey), outside, signal };
  }
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!mutations.has(exec.name)) return next();
    const value = await targets(exec), record = { cwd: value.cwd, keys: value.keys, approved: !value.outside.length };
    captured.set(exec.token, record);
    if (value.outside.length && expert) return { kind: "deny", reason: "专家不能修改工作区外文件。" };
    const policy = await next(); value.signal.throwIfAborted(); check();
    if (policy.kind === "deny" || policy.kind === "cancel" || !value.outside.length) return policy;
    const scopeReason = "Personal Bot: confirm changes outside the original workspace: " + JSON.stringify(value.outside);
    const reason = [policy.kind === "ask" ? policy.reason : undefined, scopeReason].filter(Boolean).join("\n");
    const outcome = await ctx.approval.request({ agent, toolName: exec.name, callId: exec.callId, signal: value.signal, reason,
      displayReason: { en: reason, "zh-CN": "允许本次修改原工作区之外的文件：" + value.outside.join("、") + (policy.kind === "ask" && policy.reason ? "\n" + policy.reason : "") } });
    value.signal.throwIfAborted(); check();
    record.approved = outcome === "allowed-once";
    return record.approved ? { kind: "allow" } : { kind: "deny", reason: "用户未确认文件修改。" };
  });
  ctx.on("tools/execute", async (exec, next) => {
    if (!mutations.has(exec.name)) return next();
    const record = captured.get(exec.token);
    requireThat(record?.approved, "文件操作没有有效的范围检查或确认。");
    const value = await targets(exec);
    requireThat(record.cwd === value.cwd && record.keys.length === value.keys.length && record.keys.every((key, index) => key === value.keys[index]), "确认期间文件路径或工作目录已变化。");
    return next();
  });
  ctx.on("tools/result", exec => { captured.delete(exec.token); });
}
