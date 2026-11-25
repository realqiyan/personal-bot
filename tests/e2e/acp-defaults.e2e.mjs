import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { McpWorkerRuntime } from "../../dist/extension/mcp-workers.js";
import { AgentFiles, descriptor } from "../../dist/storage/agent-files.js";
import { claudeRequests } from "../helpers/claude-session.mjs";

// This file runs only through test:e2e:acp, which uses real native host configuration and model calls.
const outputRoot = process.env.PBOT_ACP_E2E_OUTPUT_DIR ? resolve(process.env.PBOT_ACP_E2E_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), "pbot-acp-default-e2e-"));
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ event: "acp-e2e-artifacts", directory: outputRoot }));

const cases = [{ backend: "pi" }, { backend: "dsh" }, { backend: "claude" }, { backend: "claude", thinking: "low" }];
for (const { backend, thinking } of cases) test(`real ACP E2E: ${backend} ${thinking ? "explicit thinking overrides native env" : "uses its default model and thinking level"}`, { timeout: 240000 }, async t => {
  const root = await realpath(await mkdtemp(join(outputRoot, backend + (thinking ? "-" + thinking : "") + "-"))), control = join(root, "control");
  const command = process.env["PBOT_ACP_E2E_" + backend.toUpperCase() + "_COMMAND"];
  const acp = command ? { [backend]: { command, args: backend === "dsh" ? ["--profile", "acp"] : [] } } : {};
  await mkdir(join(root, ".pbot"));
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true, acp }), { mode: 0o600 });
  if (thinking) {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.local.json"), JSON.stringify({ effortLevel: "high", env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } }), { mode: 0o600 });
  }
  const runtime = new McpWorkerRuntime(control, randomUUID());
  const files = new AgentFiles(control);
  t.after(() => runtime.close());
  const input = { nonce: randomUUID(), values: Array.from({ length: 5 }, () => randomInt(1, 100)) };
  await writeFile(join(root, "input.json"), JSON.stringify(input), { mode: 0o600 });
  const expected = { nonce: input.nonce, total: input.values.reduce((sum, value) => sum + value, 0) };
  const call = args => runtime.callTool("pbot_worker", { workspace: root, ...args });
  const created = await call({
    action: "start",
    backend,
    ...(thinking ? { thinking } : {}),
    name: "default-model-e2e",
    message: 'Read input.json in the current directory. Sum its values and write output.json as a JSON object with the original nonce and the computed total. Work only in this directory. Reply briefly after the file is written.',
  });
  const workerId = created.workerId;
  await writeFile(join(root, "context.json"), JSON.stringify({ backend, root, control, workerId }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-started", backend, workspace: root, workerId }));
  let current, progress = "";
  while (!t.signal.aborted) {
    current = await call({ action: "status", workerId });
    const marker = JSON.stringify({ state: current.state, activity: current.activity, selection: current.selection });
    if (marker !== progress) { progress = marker; console.log(JSON.stringify({ event: "acp-e2e-progress", backend, ...JSON.parse(marker) })); }
    assert.notEqual(current.state, "error", current.error);
    assert.notEqual(current.state, "stopped", current.error);
    if (current.cycle?.requestIds.includes(created.requestId) && current.cycle.state !== "running") break;
    await delay(250, undefined, { signal: t.signal });
  }
  t.signal.throwIfAborted();
  assert.equal(current.cycle.state, "completed", current.cycle.error);
  assert.equal(current.transport, "acp");
  assert.equal(typeof current.selection?.model, "string");
  assert.equal(typeof current.selection?.thinking, "string");
  const stored = files.read(workerId, "descriptor.json", descriptor);
  for (const key of ["provider", "model"]) assert.equal(Object.hasOwn(stored.options, key), false);
  if (thinking) assert.equal(stored.options.thinking, thinking);
  else assert.equal(Object.hasOwn(stored.options, "thinking"), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "output.json"), "utf8")), expected);
  let nativeRequests;
  if (backend === "claude") {
    nativeRequests = await claudeRequests(files.reference(workerId).sessionId, root);
    assert.ok(nativeRequests.length);
    for (const request of nativeRequests) {
      assert.equal(request.model, current.selection.resolvedModel);
      assert.equal(request.thinking, current.selection.thinking);
      if (thinking) assert.equal(request.thinking, thinking);
    }
    await writeFile(join(root, "native-requests.json"), JSON.stringify(nativeRequests, null, 2), { mode: 0o600 });
  }
  let offset = 0, report = "";
  do {
    const page = await call({ action: "read", workerId, cycleId: current.cycle.cycleId, offset, limit: 29 });
    report += page.report; offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(report.trim());
  await writeFile(join(root, "report.txt"), report, { mode: 0o600 });
  const result = {
    backend, selection: current.selection, workerId, cycleId: current.cycle.cycleId,
    ...(thinking ? { requestedThinking: thinking } : {}), ...(nativeRequests ? { nativeRequests } : {}),
    state: current.cycle.state, workspace: root, result: expected, reportLength: report.length,
  };
  const stoppingAt = Date.now();
  await call({ action: "stop", workerId });
  await runtime.close();
  const stopMs = Date.now() - stoppingAt;
  await writeFile(join(root, "result.json"), JSON.stringify({ ...result, stopMs }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-passed", ...result, stopMs }));
});
