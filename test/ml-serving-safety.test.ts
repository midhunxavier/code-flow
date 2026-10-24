import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { inferenceInput, servingConfig } from "../src/ml/deployment-model.js";
test("serving extraction rejects traversal, links, duplicates, changed weights and oversized exports", () => {
  execFileSync("python3", ["-B", "training/test_inference.py"], { stdio: "pipe", timeout: 15000 });
});
test("serving limits and inference inputs cannot widen their admitted bounds", () => {
  const config = servingConfig({ device: "cpu", cpus: 1, timeoutSeconds: 5, maxRows: 2, maxInputTokens: 32, maxNewTokens: 8 }, true);
  const r = { recipe: "llm-sft-lora-v1", config } as Parameters<typeof inferenceInput>[1];
  for (const input of [{ prompt: "x", maxNewTokens: 9 }, { prompt: "x", messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "assistant", content: "x" }] }, { prompt: "x", command: "exec" }, { prompt: "大".repeat(22000) }]) assert.throws(() => inferenceInput(input, r));
  for (const patch of [{ timeoutSeconds: 91 }, { device: "cuda", gpu: "0" }, { cpus: 33 }, { maxRows: 101 }, { maxInputTokens: 4097 }, { maxNewTokens: 513 }, { shell: "python" }]) assert.throws(() => servingConfig({ ...config, ...patch }, true));
});

test("persistent serving requires bounded residency resources without changing legacy release configs", () => {
  const legacy = { device: "cpu", cpus: 1, timeoutSeconds: 60, maxRows: 2, maxInputTokens: 32, maxNewTokens: 8 };
  assert.deepEqual(servingConfig(legacy, true), legacy);
  const resident = { ...legacy, mode: "persistent", memoryMiB: 4096, idleSeconds: 900, lifetimeSeconds: 28800 };
  assert.deepEqual(servingConfig(resident, true), resident);
  for (const patch of [{ mode: "cloud" }, { memoryMiB: 255 }, { memoryMiB: 262145 }, { memoryMiB: undefined }, { idleSeconds: 9 }, { idleSeconds: 3601 }, { lifetimeSeconds: 29 }, { lifetimeSeconds: 86401 }, { idleSeconds: 61, lifetimeSeconds: 60 }, { idleSeconds: 10.5 }, { mode: undefined }]) assert.throws(() => servingConfig({ ...resident, ...patch }, true));
  assert.throws(() => servingConfig({ ...legacy, memoryMiB: 4096 }, true));
});
