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

const cases = [
  { backend: "pi" },
  { backend: "dsh" },
  { backend: "codex" },
  { backend: "claude" },
  { backend: "claude", thinking: "low" },
  { backend: "claude", model: "sonnet", thinking: "low" },
];
for (const { backend, model, thinking } of cases) test(`real ACP E2E: ${backend} ${[model && `model=${model}`, thinking && `thinking=${thinking}`].filter(Boolean).join(" ") || "uses its default model and thinking level"}`, { timeout: 240000 }, async t => {
  const tag = [backend, model, thinking].filter(Boolean).join("-");
  const root = await realpath(await mkdtemp(join(outputRoot, tag + "-"))), control = join(root, "control");
  const command = process.env["PBOT_ACP_E2E_" + backend.toUpperCase() + "_COMMAND"];
  const acp = {
    [backend]: {
      ...(command ? { command, args: backend === "dsh" ? ["--profile", "acp"] : [] } : {}),
      permission: "allow",
    },
  };
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
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    message: 'Read input.json in the current directory. Sum its values and write output.json as a JSON object with the original nonce and the computed total. Work only in this directory. Reply briefly after the file is written.',
    waitMs: 0,
  });
  const workerId = created.workerId;
  await writeFile(join(root, "context.json"), JSON.stringify({ backend, model, thinking, root, control, workerId }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-started", backend, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), workspace: root, workerId }));
  let current, progress = "";
  while (!t.signal.aborted) {
    current = await call({ action: "status", workerId });
    const marker = JSON.stringify({ state: current.state, activity: current.activity, selection: current.selection });
    if (marker !== progress) { progress = marker; console.log(JSON.stringify({ event: "acp-e2e-progress", backend, ...JSON.parse(marker) })); }
    assert.notEqual(current.state, "error", current.error);
    assert.notEqual(current.state, "stopped", current.error);
    if (current.cycle && current.cycle.state !== "running") break;
    await delay(250, undefined, { signal: t.signal });
  }
  t.signal.throwIfAborted();
  assert.equal(current.cycle.state, "completed", current.cycle.error);
  assert.equal(current.backend, backend);
  assert.equal(typeof current.selection?.model, "string");
  assert.equal(typeof current.selection?.thinking, "string");
  const stored = files.read(workerId, "descriptor.json", descriptor);
  assert.equal(Object.hasOwn(stored.options, "provider"), false);
  if (model) assert.equal(stored.options.model, model);
  else assert.equal(Object.hasOwn(stored.options, "model"), false);
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
      if (model) assert.ok(request.model.toLowerCase().includes(model.toLowerCase()), `${request.model} did not match ${model}`);
      if (thinking) assert.equal(request.thinking, thinking);
    }
    await writeFile(join(root, "native-requests.json"), JSON.stringify(nativeRequests, null, 2), { mode: 0o600 });
  }
  let offset = 0, report = "";
  do {
    const page = await call({ action: "read", workerId, offset });
    report += page.report; offset = page.nextOffset ?? null;
  } while (offset !== null);
  assert.ok(report.trim());
  await writeFile(join(root, "report.txt"), report, { mode: 0o600 });
  const result = {
    backend, selection: current.selection, workerId,
    ...(model ? { requestedModel: model } : {}), ...(thinking ? { requestedThinking: thinking } : {}),
    ...(nativeRequests ? { nativeRequests } : {}),
    state: current.cycle.state, workspace: root, result: expected, reportLength: report.length,
  };
  const stoppingAt = Date.now();
  await call({ action: "stop", workerId });
  await runtime.close();
  const stopMs = Date.now() - stoppingAt;
  await writeFile(join(root, "result.json"), JSON.stringify({ ...result, stopMs }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-passed", ...result, stopMs }));
});
