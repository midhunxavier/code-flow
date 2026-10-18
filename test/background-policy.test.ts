import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Automations } from "../src/automation.js";
import type { Run, RunManager } from "../src/engine.js";

test("pausing automations rejects new admission and waits for an in-flight launch and durable event save", async () => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-background-policy-")); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; }); let calls = 0;
  const manager = { get: () => undefined, subscribeAll: () => () => undefined } as unknown as RunManager;
  const service = new Automations(manager, async () => { calls++; entered(); await gate; return { id: "completed-preparation", status: "done" } as Run; }, undefined, join(home, "triggers.json"));
  try {
    await service.load(); const trigger = await service.create({ name: "Policy race", enabled: true, webhook: true, isolate: false, run: { repo: "/fixture/repo", task: "A saved request", pattern: "solo", roles: { agent: ["claude"] } } });
    const firing = service.fire(trigger.id, { via: "manual" }); await started;
    let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
    assert.deepEqual(service.accept(trigger.id, {}), { ignored: "Automation dispatch is paused" });
    assert.match((await service.fire(trigger.id, { via: "manual" })).skipped!, /paused/); await service.tick(); assert.equal(calls, 1); assert.equal(stopped, false, "a pending preparation cannot be mistaken for an idle stopped timer");
    release(); await firing; await stopping; assert.equal(stopped, true); assert.equal(service.events(trigger.id)[0]!.state, "started");
    const reloaded = new Automations(manager, async () => { throw new Error("unexpected dispatch"); }, undefined, join(home, "triggers.json")); await reloaded.load(); assert.equal(reloaded.events(trigger.id)[0]!.runIds![0], "completed-preparation", "pause waits for the final authoritative event save");
    service.start(60_000); assert.equal((await service.fire(trigger.id, { via: "manual" })).run!.id, "completed-preparation"); assert.equal(calls, 2, "explicit service restart restores dispatch");
  } finally { release?.(); await service.stop(); await rm(home, { recursive: true, force: true }); }
});
