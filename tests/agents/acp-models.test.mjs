import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { acpChoices, acpModelSelection, acpModelValue, acpThinkingValue } from "../../dist/integrations/acp/model-selection.js";
import { openAcp } from "../../dist/integrations/acp/connection.js";

const select = (id, currentValue, entries, category = id) => ({ id, category, type: "select", name: id, currentValue,
  options: entries.map(value => ({ value, name: value })) });
const dshValue = (provider, model) => JSON.stringify([provider, model]);

test("Pi ACP accepts provider-qualified and native model IDs containing slashes", () => {
  const options = [select("model", "magpie/codex/gpt-6.1-sol", ["magpie/codex/gpt-6.1-sol", "deepseek/deepseek-flash"]),
    select("thought_level", "max", ["low", "high", "max"])];
  assert.deepEqual(acpModelValue("pi", options, "codex/gpt-6.1-sol"), { configId: "model", value: "magpie/codex/gpt-6.1-sol" });
  assert.equal(acpModelValue("pi", options, "codex/gpt-6.1-sol", "magpie").value, "magpie/codex/gpt-6.1-sol");
  assert.equal(acpModelValue("pi", options, "magpie/gpt-6.1-sol").value, "magpie/codex/gpt-6.1-sol");
  assert.equal(acpModelValue("pi", options, "deepseek/deepseek-flash").value, "deepseek/deepseek-flash");
  assert.deepEqual(acpModelSelection("pi", options), { provider: "magpie", model: "codex/gpt-6.1-sol", thinking: "max" });
  const { category: _category, ...uncategorized } = options[1];
  assert.deepEqual(acpThinkingValue([uncategorized], "max"), { configId: "thought_level", value: "max" });
  assert.throws(() => acpModelValue("pi", options, "codex/gpt-6.1-sol", "deepseek"));
  const routed = [select("model", "custom/route/deepseek-flash", ["custom/route/deepseek-flash"])];
  assert.equal(acpModelValue("pi", routed, "deepseek-flash", "custom/route").value, "custom/route/deepseek-flash");
  assert.equal(acpModelValue("pi", routed, "custom/route/deepseek-flash").value, "custom/route/deepseek-flash");
});

test("dsh ACP resolves grouped native IDs and uses the default provider to distinguish identical model IDs", () => {
  const official = dshValue("deepseek-official", "deepseek-flash"), account = dshValue("deepseek-account", "deepseek-flash");
  const pro = dshValue("deepseek-official", "deepseek-v4-pro");
  const model = { ...select("model", official, []), options: [
    { group: "deepseek-official", name: "Official", options: [{ value: official, name: "Flash" }, { value: pro, name: "Pro" }] },
    { group: "deepseek-account", name: "Account", options: [{ value: account, name: "Flash" }] },
  ] };
  assert.equal(acpModelValue("dsh", [model], "deepseek-flash").value, official);
  assert.equal(acpModelValue("dsh", [model], "deepseek-v4-pro").value, pro);
  assert.equal(acpModelValue("dsh", [model], "deepseek-flash", "deepseek-account").value, account);
  assert.equal(acpModelValue("dsh", [model], "deepseek-account/deepseek-flash").value, account);
  assert.equal(acpModelValue("dsh", [model], "DeepSeek-Account/Flash").value, account);
  assert.equal(acpModelValue("dsh", [model], account).value, account);
  assert.deepEqual(acpModelSelection("dsh", [model]), { provider: "deepseek-official", model: "deepseek-flash" });
  assert.throws(() => acpModelValue("dsh", [{ ...model, currentValue: dshValue("another-route", "deepseek-v4-pro") }], "deepseek-flash"));
  assert.throws(() => acpModelValue("dsh", [model], "unavailable-model"));
});

test("Claude ACP preserves aliases and default effort values while rejecting unsupported levels", () => {
  const options = [select("model", "sonnet", ["default", "opus", "sonnet"]),
    select("effort", "default", ["default", "low", "medium", "high", "max"], "thought_level")];
  assert.deepEqual(acpModelValue("claude", options, "opus"), { configId: "model", value: "opus" });
  assert.deepEqual(acpThinkingValue(options, "high"), { configId: "effort", value: "high" });
  assert.deepEqual(acpModelSelection("claude", options), { model: "sonnet", thinking: "default" });
  assert.throws(() => acpThinkingValue(options, "unsupported"));
  assert.throws(() => acpThinkingValue([options[0]], "high"));
  assert.deepEqual(acpModelSelection("claude", []), {});
  assert.deepEqual(acpModelSelection("claude", options, "max"), { model: "sonnet", thinking: "max" });
  assert.deepEqual(acpModelSelection("claude", [options[0]], "max"), { model: "sonnet" });
  assert.deepEqual(acpModelSelection("claude", [options[0]], "unset"), { model: "sonnet", thinking: "unset" });
  assert.equal(acpModelSelection("claude", [options[0], select("effort", "high", ["low", "high"], "thought_level")], "max").thinking, "high");
});

test("model and thinking resolution supports display names, case-insensitive and unique partial matches", () => {
  const options = [
    {
      id: "model",
      category: "model",
      type: "select",
      name: "Model",
      currentValue: "claude-sonnet-4-5",
      options: [
        { value: "claude-opus-4-5", name: "Opus 4.5" },
        { value: "claude-sonnet-4-5", name: "Sonnet 4.5" },
      ],
    },
    {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      name: "Thinking",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ],
    },
  ];
  assert.equal(acpModelValue("claude", options, "Opus 4.5").value, "claude-opus-4-5");
  assert.equal(acpModelValue("claude", options, "OPUS").value, "claude-opus-4-5");
  assert.equal(acpModelValue("claude", options, "sonnet").value, "claude-sonnet-4-5");
  assert.throws(() => acpModelValue("claude", options, "claude"));
  assert.throws(() => acpModelValue("claude", options, "---"));
  assert.equal(acpThinkingValue(options, "HIGH").value, "high");
  assert.equal(acpThinkingValue(options, "Extra High").value, "xhigh");
  assert.equal(acpThinkingValue(options, "x-high").value, "xhigh");
  assert.throws(() => acpThinkingValue([{ ...options[1], options: [{ value: "xhigh", name: "Extra High" }] }], "high"));
  assert.throws(() => acpThinkingValue(options, "---"));

  // Default provider tie-breaker applies after lenient display-name matching too.
  const official = dshValue("deepseek-official", "deepseek-flash"), account = dshValue("deepseek-account", "deepseek-flash");
  const grouped = [{ ...select("model", official, []), options: [
    { group: "deepseek-official", name: "Official", options: [{ value: official, name: "Flash" }] },
    { group: "deepseek-account", name: "Account", options: [{ value: account, name: "Flash" }] },
  ] }];
  assert.equal(acpModelValue("dsh", grouped, "flash").value, official);
  assert.equal(acpModelValue("dsh", grouped, "flash", "DeepSeek-Account").value, account);

  const choices = acpChoices(options);
  assert.equal(choices.currentModel, "claude-sonnet-4-5");
  assert.equal(choices.currentThinking, "medium");
  assert.deepEqual(choices.models.map(item => item.value), ["claude-opus-4-5", "claude-sonnet-4-5"]);
  assert.deepEqual(choices.thinking.map(item => item.value), ["low", "medium", "high", "xhigh"]);
});

test("the real dsh ACP configuration keeps defaults when omitted and applies model and reasoning independently", { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pbot-acp-models-")));
  const reference = { host: "acp", backend: "dsh", command: fileURLToPath(new URL("../../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url)),
    args: ["--profile", "acp"], sessionId: null };
  let connection;
  try {
    connection = await openAcp(reference, root, { ...process.env, DSH_HOME: join(root, "home"), DSH_AGENTS_HOME: join(root, "agents") }, {
      update() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }),
    }, new AbortController().signal);
    const defaults = connection.selection();
    assert.deepEqual(await connection.configure({}), defaults);
    assert.equal(defaults.provider, "deepseek-official"); assert.equal(defaults.model, "deepseek-v4-flash");
    assert.equal(typeof defaults.thinking, "string");
    const modelOnly = await connection.configure({ model: defaults.model });
    assert.equal(modelOnly.model, defaults.model); assert.equal(modelOnly.provider, defaults.provider);
    const thinkingOnly = await connection.configure({ thinking: "max" });
    assert.equal(thinkingOnly.model, modelOnly.model); assert.equal(thinkingOnly.thinking, "max");
    assert.deepEqual(await connection.configure({}), thinkingOnly);
    const both = await connection.configure({ model: defaults.model, thinking: "low" });
    assert.equal(both.model, defaults.model); assert.equal(both.thinking, "low");
    await assert.rejects(connection.configure({ model: "not-advertised" }));
    await assert.rejects(connection.configure({ thinking: "not-advertised" }));
    assert.deepEqual(connection.selection(), both);
    t.diagnostic(JSON.stringify({ defaults, selected: both }));
  } finally { await connection?.close(); await rm(root, { recursive: true, force: true }); }
});
