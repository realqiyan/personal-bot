import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AgentService } from "../../dist/services/agents/agent-service.js";
import { AgentBackends } from "../../dist/integrations/acp/agents.js";
import { PiAgents } from "../../dist/integrations/pi/pi-agents.js";
import { executeAgent } from "../../dist/tools/agents/actions.js";
import { readWorkspaceConfig } from "../../dist/services/workspace/workspace-config.js";
import { descriptor } from "../../dist/storage/agent-files.js";
import { claudeRequests } from "../helpers/claude-session.mjs";

// This file runs only through test:e2e:acp, which uses real native host configuration and model calls.
const outputRoot = process.env.PBOT_ACP_E2E_OUTPUT_DIR ? resolve(process.env.PBOT_ACP_E2E_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), "pbot-acp-default-e2e-"));
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ event: "acp-e2e-artifacts", directory: outputRoot }));

const cases = [{ backend: "pi" }, { backend: "dsh" }, { backend: "claude" }, { backend: "claude", thinking: "low" }];
for (const { backend, thinking } of cases) test(`real ACP E2E: ${backend} ${thinking ? "explicit thinking overrides native env" : "uses its default model and thinking level"}`, { timeout: 240000 }, async t => {
  const root = await realpath(await mkdtemp(join(outputRoot, backend + (thinking ? "-" + thinking : "") + "-"))), control = join(root, "control");
  const owner = { sessionId: randomUUID(), leaf: null, branch: [] };
  const command = process.env["PBOT_ACP_E2E_" + backend.toUpperCase() + "_COMMAND"];
  const acp = command ? { [backend]: { command, args: backend === "dsh" ? ["--profile", "acp"] : [] } } : {};
  await mkdir(join(root, ".pbot"));
  await writeFile(join(root, ".pbot/config.json"), JSON.stringify({ enabled: true, acp }), { mode: 0o600 });
  if (thinking) {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.local.json"), JSON.stringify({ effortLevel: "high", env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } }), { mode: 0o600 });
  }
  const configuration = await readWorkspaceConfig(root);
  assert.equal(configuration.enabled, true, configuration.error);
  const service = new AgentService(root, control, new AgentBackends(new PiAgents(), control, configuration.acp));
  t.after(() => service.close(owner));
  const input = { nonce: randomUUID(), values: Array.from({ length: 5 }, () => randomInt(1, 100)) };
  await writeFile(join(root, "input.json"), JSON.stringify(input), { mode: 0o600 });
  const expected = { nonce: input.nonce, total: input.values.reduce((sum, value) => sum + value, 0) };
  const call = async args => (await executeAgent(service, args, owner)).structuredContent;
  const created = await call({ action: "start", backend, ...(thinking ? { thinking } : {}), name: "default-model-e2e", message:
    'Read input.json in the current directory. Sum its values and write output.json as a JSON object with the original nonce and the computed total. Work only in this directory. Reply briefly after the file is written.' });
  await writeFile(join(root, "context.json"), JSON.stringify({ backend, root, control, owner, agentId: created.agentId }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-started", backend, workspace: root, agentId: created.agentId }));
  let current, progress = "", approvals = "";
  while (!t.signal.aborted) {
    current = await call({ action: "status", agentId: created.agentId });
    const marker = JSON.stringify({ state: current.state, activity: current.activity, selection: current.selection });
    if (marker !== progress) { progress = marker; console.log(JSON.stringify({ event: "acp-e2e-progress", backend, ...JSON.parse(marker) })); }
    assert.notEqual(current.state, "error", current.error);
    assert.notEqual(current.state, "stopped", current.error);
    if (current.cycle?.requestIds.includes(created.requestId) && current.cycle.state !== "running") break;
    const pending = service.pendingPermissions(owner);
    if (pending.length && JSON.stringify(pending) !== approvals) {
      approvals = JSON.stringify(pending);
      await writeFile(join(root, "permissions.json"), JSON.stringify(pending, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ event: "acp-e2e-permission", backend, workspace: root, requests: pending.map(request => request.requestId) }));
    }
    await delay(250, undefined, { signal: t.signal });
  }
  t.signal.throwIfAborted();
  assert.equal(current.cycle.state, "completed", current.cycle.error);
  assert.equal(current.transport, "acp");
  assert.equal(typeof current.selection?.model, "string");
  assert.equal(typeof current.selection?.thinking, "string");
  const stored = service.files.read(created.agentId, "descriptor.json", descriptor);
  for (const key of ["provider", "model"]) assert.equal(Object.hasOwn(stored.options, key), false);
  if (thinking) assert.equal(stored.options.thinking, thinking);
  else assert.equal(Object.hasOwn(stored.options, "thinking"), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "output.json"), "utf8")), expected);
  let nativeRequests;
  if (backend === "claude") {
    nativeRequests = await claudeRequests(service.files.reference(created.agentId).sessionId, root);
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
    const page = await call({ action: "read", agentId: created.agentId, cycleId: current.cycle.cycleId, offset, limit: 29 });
    report += page.report; offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(report.trim());
  await writeFile(join(root, "report.txt"), report, { mode: 0o600 });
  const result = { backend, selection: current.selection, agentId: created.agentId, cycleId: current.cycle.cycleId,
    ...(thinking ? { requestedThinking: thinking } : {}), ...(nativeRequests ? { nativeRequests } : {}),
    state: current.cycle.state, workspace: root, result: expected, reportLength: report.length };
  const stoppingAt = Date.now();
  await call({ action: "stop", agentId: created.agentId });
  await service.close(owner);
  const releaseDeadline = Date.now() + 1500;
  while (service.host.alive(created.agentId) && Date.now() < releaseDeadline) await delay(25);
  assert.equal(service.host.alive(created.agentId), false);
  const stopMs = Date.now() - stoppingAt;
  await writeFile(join(root, "result.json"), JSON.stringify({ ...result, stopMs }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: "acp-e2e-passed", ...result, stopMs }));
});
