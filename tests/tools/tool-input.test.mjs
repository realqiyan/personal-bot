import test from "node:test";
import assert from "node:assert/strict";
import { agentParametersSchema, agentInput } from "../../dist/tools/agents/contract.js";
import { teamParametersSchema, teamMessageParametersSchema, teamInput, teamMessageInput } from "../../dist/tools/teams/contract.js";
import { historyParameters, historyInput } from "../../dist/tools/history/contract.js";
import { schema } from "../../dist/common/schema.js";

// Model-facing tools use one flat record per resource. These tests hold the invariant that
// every declared field is accepted for every action, while each action reads only its own fields.

function record(parameters, values = {}) {
  return { ...Object.fromEntries(Object.keys(parameters.properties).map(key => [key, null])), ...values };
}

test("pbot_agent accepts every declared field for every action and projects only the active fields", () => {
  const cases = [
    [{ action: "start", message: "work", name: "expert" }, ["message", "name"]],
    [{ action: "send", agentId: "a", message: "continue", delivery: "followUp" }, ["agentId", "message", "delivery"]],
    [{ action: "resume", agentId: "a", message: "again" }, ["agentId", "message"]],
    [{ action: "rename", agentId: "a", name: "renamed" }, ["agentId", "name"]],
    [{ action: "status", agentId: "a" }, ["agentId"]],
    [{ action: "stop", agentId: "a" }, ["agentId"]],
    [{ action: "read", agentId: "a", cycleId: "c", offset: 0, limit: 10 }, ["agentId", "cycleId", "offset", "limit"]],
    [{ action: "list" }, []],
  ];
  for (const [active, keys] of cases) {
    const args = record(agentParametersSchema, active);
    assert.equal(schema(agentParametersSchema)(args), true, active.action);
    assert.deepEqual(Object.keys(agentInput(args)).sort(), ["action", ...keys].sort(), active.action);
  }
  assert.equal(Object.hasOwn(agentParametersSchema.properties, "prompts"), false);
  assert.deepEqual(agentParametersSchema.required, ["action"]);
});

test("non-null fields outside the active mode are ignored and null means absent", () => {
  const args = record(agentParametersSchema, { action: "start", agentId: "unused", cycleId: "unused", delivery: "steer",
    offset: 0, limit: 16000, name: "组合复核", message: "只读复核组合结构。", backend: "pi", noExtensions: true });
  assert.deepEqual(agentInput(args), { action: "start", backend: "pi", name: "组合复核", message: "只读复核组合结构。", noExtensions: true });
  assert.deepEqual(agentInput({ action: "list", agentId: null, message: null, limit: null }), { action: "list" });
});

test("pbot_agent keeps shape checks and names missing inputs", () => {
  assert.throws(() => agentInput({ action: "start", unknown: 1 }), /unknown/);
  assert.throws(() => agentInput({ action: "send", agentId: "a" }), /message/);
  assert.throws(() => agentInput({ action: "rename", agentId: "a" }), /name/);
  assert.throws(() => agentInput({ action: "send", agentId: "a", message: null }), /message/);
  assert.throws(() => agentInput({ action: "start", provider: "openai" }), /model/);
  assert.throws(() => agentInput({ action: "wait" }), /action/);
});

test("pbot_team has no transcript read action, and team tools project their own modes", () => {
  assert.equal(Object.hasOwn(teamParametersSchema.properties, "afterSeq"), false);
  assert.throws(() => teamInput({ action: "read", teamId: "t" }), /action/);
  const cases = [
    [{ action: "create", name: "team", brief: "review", members: [{ agentId: "m", role: "review" }] }, ["name", "brief", "members"]],
    [{ action: "status", teamId: "t" }, ["teamId"]],
    [{ action: "run", teamId: "t", instruction: "work", mode: "parallel" }, ["teamId", "instruction", "mode"]],
    [{ action: "list" }, []],
  ];
  for (const [active, keys] of cases) {
    const args = record(teamParametersSchema, active);
    assert.equal(schema(teamParametersSchema)(args), true, active.action);
    assert.deepEqual(Object.keys(teamInput(args)).sort(), ["action", ...keys].sort(), active.action);
  }
  assert.deepEqual(teamInput({ action: "list", teamId: "unused", name: "unused", instruction: "unused" }), { action: "list" });
  assert.throws(() => teamInput({ action: "run", teamId: "t", mode: "parallel" }), /instruction/);

  const message = record(teamMessageParametersSchema, { action: "post", teamId: "t", text: "public",
    afterSeq: 0, seq: 1, offset: 0, limit: 10, replyTo: 2 });
  assert.deepEqual(teamMessageInput(message), { action: "post", teamId: "t", text: "public", replyTo: 2 });
  const read = teamMessageInput(record(teamMessageParametersSchema, { action: "read", teamId: "t", text: "ignored", replyTo: 2 }));
  assert.equal(read.action, "read"); assert.equal(Object.hasOwn(read, "text"), false); assert.equal(Object.hasOwn(read, "replyTo"), false);
  assert.throws(() => teamMessageInput({ action: "post", teamId: "t" }), /text/);
});

test("pbot_history keeps one flat record and distinguishes search from read inputs", () => {
  assert.equal(Object.hasOwn(historyParameters.properties, "childrenOffset"), true);
  const search = historyInput(record(historyParameters, { action: "search", query: "work", id: "ignored", childrenOffset: 4 }));
  assert.equal(Object.hasOwn(search, "id"), false); assert.equal(Object.hasOwn(search, "childrenOffset"), false);
  const read = historyInput(record(historyParameters, { action: "read", id: "node", query: "ignored", from: "ignored" }));
  assert.equal(read.id, "node"); assert.equal(Object.hasOwn(read, "query"), false); assert.equal(Object.hasOwn(read, "from"), false);
  assert.throws(() => historyInput({ action: "read" }), /id/);
  assert.throws(() => historyInput({ action: "search", limit: 51 }), /50/);
});
