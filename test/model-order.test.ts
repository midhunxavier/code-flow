import { test } from "node:test";
import assert from "node:assert/strict";
import { freeModelsFirst } from "../ui/model-order.js";
test("free models precede other models without reordering groups or mutating the provider catalog", () => {
  const models = [
    { id: "a", label: "Paid A" }, { id: "gateway/model:free", label: "Free variant" },
    { id: "freeman", label: "Freeman" }, { id: "b", label: "Model B (free)" },
    { id: "unknown", label: "Unknown pricing" },
  ];
  assert.deepEqual(freeModelsFirst(models).map(m => m.id), ["gateway/model:free", "b", "a", "freeman", "unknown"]);
  assert.equal(models[0]!.id, "a");
});


test("additional model settings use the same validation as primary models", async () => {
  const { validateAgentSettings } = await import("../src/adapters/index.js");
  const value = { codex: { model: "first", variants: [{ model: "second", effort: "low" }] } };
  assert.deepEqual(validateAgentSettings(value), value);
  assert.throws(() => validateAgentSettings({ codex: { variants: [{ model: "--inject" }] } }), /Invalid model/);
  assert.throws(() => validateAgentSettings({ codex: { variants: [{ model: "second", variants: [] }] } }), /additional agent/);
});
