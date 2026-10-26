import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Notifications, notificationEvents } from "../src/notifications.js";
import type { RunSummary, Run, RunManager } from "../src/engine.js";

const scratch = await mkdtemp("/private/tmp/cf-qa-notifications-unit-");
const services: Notifications[] = [];
const config = [{ id: "fixture", name: "QA destination", protocol: "webhook", urlEnv: "QA_OUTBOUND_URL", secretEnv: "QA_OUTBOUND_TOKEN" }];
const env = { QA_OUTBOUND_URL: "https://notification-fixture.invalid/private-hook", QA_OUTBOUND_TOKEN: "private-fixture-token" };
const run = (extra: Partial<RunSummary> = {}) => ({ id: "qa-run", task: "Fixture task", pattern: "pipeline", project: "qa-project", status: "done", createdAt: 1, endedAt: 100, verdict: "passed", watches: {}, ...extra } as RunSummary);
async function service(fetcher: typeof fetch = async () => new Response("ok"), now = () => Date.now()) {
  const directory = await mkdtemp(join(scratch, "case-")), file = join(directory, "notifications.json");
  const value = new Notifications({ file, environment: env, fetch: fetcher, now }); services.push(value); await value.load(config);
  await value.update("fixture", { enabled: true, events: ["done", "failure", "needs-attention"], projects: "all" });
  return { value, file };
}
after(async () => { for (const value of services) await value.stop(); await rm(scratch, { recursive: true, force: true }); });

test("shutdown interruptions do not become failures; real failures and fresh approval waits still notify", async () => {
  const requests: any[] = [];
  const { value } = await service(async (_input, options) => { requests.push(JSON.parse(String(options?.body))); return new Response("ok"); });
  const interrupted = run({ status: "interrupted", error: "code-flow was shut down while this run was in progress. Resume to continue." });
  assert.deepEqual(notificationEvents(interrupted), []); await value.observe(interrupted); await value.drain(); assert.equal(requests.length, 0);
  for (const status of ["failed", "stopped"] as const) assert.equal(notificationEvents(run({ status }))[0]?.event, "failure");
  assert.equal(notificationEvents(run({ verdict: "failing" }))[0]?.event, "failure");
  const waiting = run({ status: "running", endedAt: undefined, awaiting: { kind: "plan", title: "Approve plan", content: "Fixture", at: 101 } });
  await value.observe(waiting); await value.drain(); await value.observe(waiting); await value.drain();
  await value.observe({ ...waiting, awaiting: { ...waiting.awaiting!, at: 102 } }); await value.drain();
  assert.deepEqual(requests.map(request => request.event), ["needs-attention", "needs-attention"]);
});

test("real fetch refuses redirects once, retains only status and never sends credentials to Location", async () => {
  const hits: string[] = [];
  const receiver = createServer((req, res) => { hits.push(req.url!); res.writeHead(Number(req.url?.slice(1)) || 200, { location: "/private-location?token=secret-location" }); res.end("private response text"); });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  try {
    for (const status of [302, 307, 308]) {
      let now = 1_000;
      const { value } = await service((_input, options) => fetch(base + `/${status}`, options), () => now);
      await value.test("fixture"); await value.drain(); const delivery = value.deliveries()[0]!;
      assert.equal(delivery.state, "failed"); assert.equal(delivery.attempts, 1); assert.match(delivery.reason!, /redirect/i); assert.equal(delivery.httpStatus, status);
      assert.equal(delivery.nextAttemptAt, undefined); now += 600_000; await value.drain();
      assert.doesNotMatch(JSON.stringify(value.deliveries()), /secret-location|private-location|private response|private-fixture/);
    }
    assert.deepEqual(hits, ["/302", "/307", "/308"]);
  } finally { await new Promise<void>(resolve => receiver.close(() => resolve())); }
});

test("scope narrowing and disabling remove retry times from cancelled deliveries", async () => {
  for (const settings of [{ enabled: false, events: ["done"], projects: "all" }, { enabled: true, events: ["failure"], projects: "all" }, { enabled: true, events: ["done"], projects: ["other-project"] }]) {
    let calls = 0, now = 1000;
    const { value, file } = await service(async () => { calls++; return new Response("retry", { status: 500 }); }, () => now);
    await value.observe(run()); await value.drain(); assert.ok(value.deliveries()[0]?.nextAttemptAt);
    await value.update("fixture", settings); const delivery = value.deliveries()[0]!; assert.equal(delivery.state, "cancelled"); assert.equal(delivery.nextAttemptAt, undefined);
    assert.equal(JSON.parse(await readFile(file, "utf8")).deliveries[0].nextAttemptAt, undefined); now += 600_000; await value.drain(); assert.equal(calls, 1);
  }
});

test("loading removes obsolete retry times and claim-time terminal paths clear them", async () => {
  const { value, file } = await service(); await value.test("fixture"); await value.drain(); await value.stop();
  const saved = JSON.parse(await readFile(file, "utf8"));
  for (const state of ["cancelled", "failed", "delivered", "sending"]) {
    const data = structuredClone(saved); data.deliveries[0].state = state; data.deliveries[0].nextAttemptAt = 10;
    await writeFile(file, JSON.stringify(data)); const restored = new Notifications({ file, environment: env }); services.push(restored); await restored.load(config);
    assert.equal(restored.deliveries()[0]!.nextAttemptAt, undefined, state);
  }
  for (const attempts of [0, 3]) {
    const data = structuredClone(saved); Object.assign(data.deliveries[0], { state: "pending", attempts, nextAttemptAt: 1 }); await writeFile(file, JSON.stringify(data));
    let calls = 0; const restored = new Notifications({ file, environment: env, fetch: async () => { calls++; return new Response("unexpected"); }, now: () => 2 * 24 * 60 * 60_000 }); services.push(restored); await restored.load(config); await restored.drain();
    assert.equal(restored.deliveries()[0]!.state, attempts === 3 ? "failed" : "cancelled"); assert.equal(restored.deliveries()[0]!.nextAttemptAt, undefined); assert.equal(calls, 0);
  }
});

test("a real PR watcher emits one attention notification over six hours of repeated failed polls", async () => {
  const previous = { PATH: process.env.PATH, SHELL: process.env.SHELL, FAKE_GH_STATE: process.env.FAKE_GH_STATE, HOME: process.env.HOME };
  const repo = join(scratch, "watch-repo"); await mkdir(repo); await mkdir(join(scratch, "os-home"));
  await writeFile(join(scratch, "gh.json"), JSON.stringify({ signedOut: true })); await writeFile(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${previous.PATH}`; process.env.FAKE_GH_STATE = join(scratch, "gh.json"); process.env.SHELL = join(scratch, "bash"); process.env.HOME = join(scratch, "os-home");
  try {
    const { PrWatcher } = await import("../src/watch.js"); let now = 1_000, calls = 0;
    const { value, file } = await service(async () => { calls++; return new Response("ok"); }, () => now);
    const snapshot = run({ repo, status: "done", endedAt: undefined, watches: { branch: { branch: "branch", pr: "https://github.com/fixture/repo/pull/1", remoteBranch: "feature", agent: "codex", maxFixes: 3, fixes: 0, state: "watching", detail: "Watching", fixedHeads: [], startedAt: 1 } } }) as Run;
    let pending: Promise<unknown>[] = []; const manager = { watchedRuns: () => [snapshot], updateWatch: (_id: string, branch: string, patch: object) => { Object.assign(snapshot.watches[branch]!, patch); pending.push(value.observe(snapshot)); } } as unknown as RunManager;
    let watcher = new PrWatcher(manager, 60_000);
    for (let minute = 0; minute <= 360; minute++) { now = 1_000 + minute * 60_000; await watcher.poll(now); await Promise.all(pending); pending = []; await value.drain(); if (minute === 180) { await watcher.stop(); watcher = new PrWatcher(manager, 60_000); } }
    await watcher.stop(); assert.ok(snapshot.watches.branch!.pollFailures! > 10); assert.equal(calls, 1); assert.equal(value.deliveries().length, 1);
    const restored = new Notifications({ file, environment: env, fetch: async () => { calls++; return new Response("ok"); } }); services.push(restored); await restored.load(config); await restored.observe(snapshot); await restored.drain(); assert.equal(calls, 1);
    snapshot.watches.branch!.detail = "CI still fails after 3 fixes; over to you"; snapshot.watches.branch!.fixes = 3; await restored.observe(snapshot); await restored.drain(); assert.equal(calls, 2);
    snapshot.watches.branch!.startedAt = now; await restored.observe(snapshot); await restored.drain(); assert.equal(calls, 3, "a newly armed watch can notify again");
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
