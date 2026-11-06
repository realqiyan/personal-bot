import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentFiles, status, launch } from "../../dist/storage/agent-files.js";
import { AgentRun } from "../../dist/services/agents/agent-run.js";
import { packageVersion } from "../../dist/common/version.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pbot-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new AgentFiles(root), id = randomUUID(), generation = randomUUID();
  files.create({ agentId: id, release: packageVersion, workspace: root, cwd: root,
    parentSessionId: "parent", parentLeaf: null, createdAt: 1, options: {} },
  { generation, name: "local", sequence: 0, stop: false, startedAt: 1 });
  return { files, id, generation };
}

test("a durable receipt does not become consumed work, and reload seals it without replay", async t => {
  const { files, id, generation } = await fixture(t);
  const request = files.enqueue(id, "local work", "steer");
  const execution = new AgentRun(files, id, generation);
  execution.claim(request.requestId);
  execution.begin();
  // These are domain end facts, without a model or provider implementation.
  execution.finish({ state: "completed", position: "durable-end", answer: "An unrelated answer" });
  assert.equal(files.completions(id)[0].state, "failed");
  assert.deepEqual(files.completions(id)[0].requestIds, []);
  const restored = new AgentRun(files, id, generation);
  restored.recover();
  const interrupted = files.completions(id).find(c => c.requestIds.includes(request.requestId));
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.leaf, null);
  const before = files.completions(id);
  restored.recover();
  assert.deepEqual(files.completions(id), before);
  restored.consume(request.requestId);
  assert.equal(restored.pending, 0);
  assert.equal(files.messages(id).length, 1);
  assert.equal(files.read(id, "launch.json", launch).generation, generation);
});

test("a native claim without model admission cannot complete, and unrun cancellation is durable", async t => {
  const { files, id, generation } = await fixture(t);
  const execution = new AgentRun(files, id, generation);
  const claimed = files.enqueue(id, "claimed", "steer");
  execution.claim(claimed.requestId);
  execution.begin(); execution.enter(claimed.requestId);
  execution.finish({ state: "completed", position: "durable-end", answer: "Unrelated response" });
  assert.equal(files.completions(id)[0].state, "failed");
  assert.deepEqual(files.completions(id)[0].requestIds, [claimed.requestId]);
  const queued = files.enqueue(id, "unrun", "followUp");
  execution.claim(queued.requestId);
  execution.cancelQueued(queued.requestId); execution.cancelQueued(queued.requestId);
  const cancelled = files.completions(id).filter(c => c.requestIds.includes(queued.requestId));
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].state, "cancelled");
  assert.equal(cancelled[0].leaf, null);
});

test("human work is attributed at native entry and succeeds only after admission", async t => {
  const { files, id, generation } = await fixture(t);
  const execution = new AgentRun(files, id, generation);
  execution.begin(); execution.enterHuman();
  assert.equal(execution.current.source, "interactive");
  execution.finish({ state: "completed", position: "durable-end", answer: "Unrelated response" });
  assert.equal(files.completions(id)[0].state, "failed");
  execution.begin(); execution.humanInput();
  execution.finish({ state: "completed", position: "new-durable-end", answer: "The requested response" });
  const completed = files.completions(id).filter(c => c.state === "completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].source, "interactive");
});

test("consumed requests retain human attribution and old generation receipts cannot create current cycles", async t => {
  const { files, id, generation } = await fixture(t);
  const request = files.enqueue(id, "parent work", "steer");
  const execution = new AgentRun(files, id, generation);
  execution.claim(request.requestId);
  execution.consume(request.requestId);
  execution.begin();
  execution.consume(request.requestId);
  execution.humanInput();
  execution.finish({ state: "completed", position: "durable-end", answer: "Stored report" });
  const completed = files.completions(id)[0];
  assert.equal(completed.source, "mixed");
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.requestIds, [request.requestId]);
  execution.consume(request.requestId);
  assert.equal(execution.pending, 0);
  const next = randomUUID();
  files.write(id, "launch.json", { ...files.read(id, "launch.json", launch), generation: next, sequence: 0 }, launch);
  // Older Pi snapshots may contain receipts from prior native generations.
  files.write(id, "status.json", { generation: next, state: "idle", activity: "idle", updatedAt: 2, accepted: [request.requestId] }, status);
  const reopened = new AgentRun(files, id, next);
  reopened.recover([{ generation, requestId: request.requestId }]);
  assert.equal(reopened.accepted(request.requestId), false);
  assert.deepEqual(files.completions(id), [completed]);
});
