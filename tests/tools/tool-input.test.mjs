import test from "node:test";
import assert from "node:assert/strict";
import { historyParameters, historyInput } from "../../dist/tools/history/contract.js";
import { schema } from "../../dist/common/schema.js";

function record(parameters, values = {}) {
  return { ...Object.fromEntries(Object.keys(parameters.properties).map(key => [key, null])), ...values };
}

test("pbot_history keeps one flat record and distinguishes search from read inputs", () => {
  assert.equal(Object.hasOwn(historyParameters.properties, "childrenOffset"), true);
  assert.equal(schema(historyParameters)(record(historyParameters, { action: "search", query: "work" })), true);
  const search = historyInput(record(historyParameters, { action: "search", query: "work", id: "ignored", childrenOffset: 4 }));
  assert.equal(Object.hasOwn(search, "id"), false); assert.equal(Object.hasOwn(search, "childrenOffset"), false);
  const read = historyInput(record(historyParameters, { action: "read", id: "node", query: "ignored", from: "ignored" }));
  assert.equal(read.id, "node"); assert.equal(Object.hasOwn(read, "query"), false); assert.equal(Object.hasOwn(read, "from"), false);
  assert.throws(() => historyInput({ action: "read" }), /id/);
  assert.throws(() => historyInput({ action: "search", limit: 51 }), /50/);
});
