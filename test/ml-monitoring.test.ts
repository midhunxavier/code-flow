import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyWindow, histogramDistance, monitorLimits, report, type ModelMonitor } from "../src/ml/monitor-model.js";
import { bin, observe } from "../src/ml/monitor-metrics.js";
const limits = { windowSeconds: 60, minRequests: 10, minSamples: 20, consecutiveWindows: 2, maxErrorRate: 0.2, maxLatencyMs: 1000, driftThreshold: 0.3, cooldownSeconds: 60, maxActions: 2 };
test("monitor limits require minimum evidence, repeated windows and finite lifetime action caps", () => {
  assert.deepEqual(monitorLimits(limits), limits);
  for (const patch of [{ windowSeconds: 59 }, { minRequests: 1 }, { minSamples: 19 }, { consecutiveWindows: 1 }, { maxActions: 0 }, { maxActions: 21 }, { maxErrorRate: NaN }, { maxErrorRate: 0 }, { driftThreshold: 1.1 }, { cooldownSeconds: 0 }, { command: "retrain" }]) assert.throws(() => monitorLimits({ ...limits, ...patch }));
});
test("histogram distance is normalized, symmetric and insensitive to total counts", () => {
  assert.equal(histogramDistance([10, 0], [0, 100]), 1);
  assert.equal(histogramDistance([10, 10], [100, 100]), 0);
  assert.ok(Math.abs(histogramDistance([1, 0], [0.5, 0.5]) - 0.5579230453) < 0.0000001);
  assert.equal(histogramDistance([2, 1], [1, 4]), histogramDistance([1, 4], [2, 1]));
  assert.throws(() => histogramDistance([0, 0], [1, 1]));
});
test("aggregate feature and LLM monitoring does not retain row values, prompts or generated text", () => {
  const m = { features: ["x"], salt: "private", limits, window: emptyWindow(1000, 60, ["x"]) } as ModelMonitor;
  for (let i = 0; i < 10; i++) observe(m, {} as any, { rows: [{ x: "private-category" }, { x: 2 }] }, { predictions: ["private-output", 2] }, 15);
  assert.equal(m.window.requests, 10); assert.equal(m.window.samples, 20);
  assert.equal(JSON.stringify(m).includes("private-category"), false); assert.equal(JSON.stringify(m).includes("private-output"), false);
  m.reference = structuredClone(m.window); m.window = emptyWindow(61000, 60, m.features);
  for (let i = 0; i < 10; i++) observe(m, {} as any, { rows: [{ x: 10000 }, { x: 10000 }] }, { predictions: [1, 1] }, 15);
  assert.equal(report(m, 121000).dataDrift, true);
  m.window = emptyWindow(121000, 60, m.features); observe(m, {} as any, { rows: [{ x: 10000 }] }, undefined, 2000);
  assert.equal(report(m, 181000).health, false, "one failure cannot authorize rollback");
  const llm = { features: ["promptCharacters", "inputTokens", "outputTokens", "emptyOutput"], salt: "private", limits } as ModelMonitor; llm.window = emptyWindow(1000, 60, llm.features);
  observe(llm, { base: {} } as any, { prompt: "secret user message", maxNewTokens: 4 }, { text: "secret generated answer", inputTokens: 5, outputTokens: 4 }, 2);
  assert.equal(JSON.stringify(llm).includes("secret"), false); assert.equal(llm.window.histograms.every(h => h.reduce((a, b) => a + b) === 1), true);
  assert.equal(llm.window.histograms[3]![bin(0, "private")], 1);
  observe(llm, { base: {} } as any, { prompt: "x", maxNewTokens: 1 }, { text: "", inputTokens: 1, outputTokens: 0 }, 2);
  assert.equal(llm.window.histograms[3]![bin(1, "private")], 1, "empty-output frequency uses distinct binary bins without hash collisions");
  assert.notEqual(bin(-2, "private"), bin(2, "private")); assert.notEqual(bin(null, "private"), bin(0, "private"));
});
