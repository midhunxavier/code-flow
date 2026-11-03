import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Automations } from "../src/automation.js";
import type { Run, RunManager } from "../src/engine.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "automation-lifecycle-")), file = join(dir,"triggers.json");
  const live = new Map<string,Run>(); let count = 0;
  const manager = { get: (id: string) => live.get(id) } as RunManager;
  const dispatch = async () => { const run = { id: `run-${++count}`, status: "done" } as Run; live.set(run.id,run); return run; };
  const auto = new Automations(manager, dispatch, undefined, file); await auto.load();
  return { auto, restore: async () => { const fresh = new Automations(manager,dispatch,undefined,file); await fresh.load(); return fresh; }, count: () => count, cleanup: () => rm(dir,{recursive:true,force:true}) };
}
const input = { name: "Review", enabled: false, webhook: false, isolate: false, run: { repo: "/repo", pattern: "cli-team", task: "Review changes" }, schedule: { every: 60 } };
test("test does not enable a schedule; repeated operation and creation IDs never duplicate work", async () => {
  const f = await fixture(); try {
    const a = await f.auto.create({ ...input, creationKey: "create-1" });
    assert.equal((await f.auto.create({ ...input, creationKey: "create-1" })).id,a.id);
    const one = await f.auto.test(a.id,a.revision,"test-1"), two = await f.auto.test(a.id,a.revision,"test-1");
    assert.equal(one.run!.id,two.run!.id); assert.equal(f.count(),1); assert.equal(f.auto.get(a.id)!.enabled,false);
    const restored = await f.restore(); await restored.test(a.id,a.revision,"test-1"); assert.equal(f.count(),1);
    await restored.update(a.id,{name:"Changed",revision:a.revision});
    await assert.rejects(restored.test(a.id,a.revision,"test-2"),/another window/);
  } finally { await f.cleanup(); }
});
test("run-once catchup collapses days of missed schedules across restart", async () => {
  const f = await fixture(); try {
    const a = await f.auto.create({ ...input, enabled:true, missedPolicy:"run_once" });
    const now = Date.now(); f.auto.get(a.id)!.nextAt = now - 5*86400000;
    await f.auto.update(a.id,{name:"Catchup"}); // persist without moving its due time
    const restored = await f.restore(); await restored.tick(now); await restored.tick(now);
    assert.equal(f.count(),1); assert.ok(restored.get(a.id)!.nextAt! > now);
  } finally { await f.cleanup(); }
});
test("one-time automation is consumed durably and remains paused after restart", async () => {
  const f = await fixture(); try {
    const now = Date.now(), a = await f.auto.create({ ...input, schedule:undefined, onceAt:now+100, enabled:true });
    await f.auto.tick(now+200); assert.equal(f.count(),1); assert.equal(f.auto.get(a.id)!.enabled,false);
    const restored = await f.restore(); await restored.tick(now+1000); assert.equal(f.count(),1);
  } finally { await f.cleanup(); }
});

test("quiet automation successes stay in history while findings and decisions need attention", async () => {
  const { chatAutomationAttention } = await import("../src/conversational/attention.js");
  const { reviewReason } = await import("../src/review-inbox.js");
  const { notificationEvents } = await import("../src/notifications.js");
  const run = { id:"test", status:"done", trigger:{id:"a"}, artifacts:[], triage:{state:"pending"}, cliTeam:{taskConversation:{phase:"execution"},outcome:"review_complete",questions:{},artifacts:{review:{kind:"review",data:{verdict:"approve",findings:[]}}}}} as any;
  assert.equal(chatAutomationAttention(run),"quiet"); assert.equal(reviewReason(run),undefined); assert.deepEqual(notificationEvents(run),[]);
  run.cliTeam.artifacts.review.data.findings=["Missing input validation"];
  assert.equal(chatAutomationAttention(run),"findings"); assert.equal(reviewReason(run),"review"); assert.equal(notificationEvents(run)[0]!.event,"needs-attention");
  run.cliTeam.questions={q:{question:"Approve implementation?"}}; run.status="running";
  assert.equal(chatAutomationAttention(run),"decision"); assert.equal(reviewReason(run),"answer");
});
