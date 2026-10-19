import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifications, notificationEvents, validateNotificationSettings, type NotificationDelivery } from "../src/notifications.js";
import type { RunSummary } from "../src/engine.js";

const directories: string[] = [], services: Notifications[] = [];
const configuration = [{ id: "fixture", name: "Fixture destination", protocol: "webhook", urlEnv: "OUTBOUND_URL", secretEnv: "OUTBOUND_CREDENTIAL" }];
const environment = { OUTBOUND_URL: "https://hooks.fixture.invalid/private-url-path?key=private-webhook-url-token", OUTBOUND_CREDENTIAL: "private-webhook-credential" };
const run = (extra: Partial<RunSummary> = {}): RunSummary => ({ id: "run-1", task: "Implement the accepted task", pattern: "pipeline", project: "project-one", status: "done", createdAt: 1, endedAt: 100, verdict: "passed", watches: {}, archived: false, ...extra } as RunSummary);
async function service(fetcher: typeof fetch, now?: () => number, config: unknown = configuration) {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-notifications-")); directories.push(directory);
  const file = join(directory, "state.json");
  const value = new Notifications({ file, environment, fetch: fetcher, now }); services.push(value); await value.load(config);
  return { value, file };
}
const enable = (value: Notifications) => value.update("fixture", { enabled: true, events: ["done", "failure", "needs-attention"], projects: ["project-one"] });
after(async () => { for (const value of services) await value.stop(); for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

test("notification defaults require explicit target/event/project opt-in and perform no outbound requests", async () => {
  let calls = 0;
  const { value, file } = await service((async () => { calls++; return new Response("ok"); }) as typeof fetch);
  assert.equal(value.list()[0]!.settings.enabled, false);
  assert.deepEqual(await value.observe(run()), { queued: 0, dropped: 0 });
  assert.equal(calls, 0);
  await assert.rejects(stat(file), /ENOENT/, "disabled notifications do not create a file per run snapshot");
  assert.throws(() => validateNotificationSettings({ enabled: true, events: [], projects: "all" }), /requires an event/);
  assert.throws(() => validateNotificationSettings({ enabled: true, events: ["done"], projects: [] }), /project scope/);
  await enable(value);
  const before = await readFile(file, "utf8");
  await value.observe(run({ project: "another-project" }));
  await value.drain();
  assert.equal(calls, 0);
  assert.equal(await readFile(file, "utf8"), before, "out-of-scope updates do not write state");
});

test("scoped events deduplicate across snapshots and restart while public metadata and payloads omit secrets", async () => {
  const requests: { url: string; options: RequestInit; body: any }[] = [];
  const fetcher = (async (url, options) => { requests.push({ url: String(url), options: options!, body: JSON.parse(String(options!.body)) }); return new Response("ok"); }) as typeof fetch;
  const { value, file } = await service(fetcher);
  await enable(value);
  const snapshot = run({ task: `A title containing ${environment.OUTBOUND_CREDENTIAL}` });
  assert.equal((await value.observe(snapshot)).queued, 1);
  await value.drain();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.options.redirect, "error");
  assert.equal(requests[0]!.options.method, "POST");
  assert.equal(new Headers(requests[0]!.options.headers).get("authorization"), `Bearer ${environment.OUTBOUND_CREDENTIAL}`);
  assert.equal(requests[0]!.body.title, "A title containing [REDACTED]");
  assert.equal(requests[0]!.body.result, "verified");
  assert.equal(requests[0]!.body.repo, undefined);
  assert.equal(requests[0]!.body.transcript, undefined);
  assert.equal(value.deliveries()[0]!.state, "delivered");
  assert.doesNotMatch(JSON.stringify({ targets: value.list(), deliveries: value.deliveries() }), /private-url-path|private-webhook|OUTBOUND_URL|OUTBOUND_CREDENTIAL/);
  const stored = await readFile(file, "utf8");
  assert.doesNotMatch(stored, /private-url-path|private-webhook/);
  assert.equal((await value.observe(snapshot)).queued, 0);
  assert.equal(await readFile(file, "utf8"), stored, "duplicate snapshots do not write or send again");
  const restored = new Notifications({ file, environment, fetch: fetcher }); services.push(restored); await restored.load(configuration);
  await restored.observe(snapshot); await restored.drain();
  assert.equal(requests.length, 1, "deduplication survives a restart");
});

test("automatic retries are bounded and manual retry preserves lifetime attempt metadata", async () => {
  let now = 1_000, calls = 0, succeeds = false;
  const { value } = await service((async () => { calls++; return new Response("upstream details are discarded", { status: succeeds ? 200 : 500 }); }) as typeof fetch, () => now);
  await enable(value); await value.observe(run()); await value.drain();
  let delivery = value.deliveries()[0]!;
  assert.equal(delivery.state, "pending"); assert.equal(delivery.attempts, 1);
  await value.drain(); assert.equal(calls, 1, "backoff is enforced");
  now = delivery.nextAttemptAt!; await value.drain(); delivery = value.deliveries()[0]!;
  assert.equal(delivery.attempts, 2);
  now = delivery.nextAttemptAt!; await value.drain(); delivery = value.deliveries()[0]!;
  assert.equal(delivery.state, "failed"); assert.equal(calls, 3);
  await value.drain(); assert.equal(calls, 3);
  succeeds = true; await value.retry(delivery.id); await value.drain(); delivery = value.deliveries()[0]!;
  assert.equal(delivery.state, "delivered"); assert.equal(delivery.totalAttempts, 4); assert.equal(delivery.retryCount, 1);
  assert.doesNotMatch(JSON.stringify(delivery), /upstream details/);
});

test("attention identities ignore polling noise and include distinct tool approval requests", async () => {
  let calls = 0;
  const { value } = await service((async () => { calls++; return new Response("ok"); }) as typeof fetch);
  await enable(value);
  const waiting = run({ status: "running", endedAt: undefined, awaiting: { kind: "plan", title: "Approve", content: "Review the pending plan", at: 50 } });
  assert.equal(notificationEvents(waiting)[0]!.event, "needs-attention");
  await value.observe(waiting); await value.drain();
  await value.observe({ ...waiting, usage: { agentSteps: 99, checks: 1 } } as RunSummary); await value.drain();
  assert.equal(calls, 1);
  const working = run({ status: "running", endedAt: undefined });
  await value.observe(working, "tool-request-1"); await value.drain();
  await value.observe(working, "tool-request-1"); await value.drain();
  await value.observe(working, "tool-request-2"); await value.drain();
  assert.equal(calls, 3);
  assert.equal(notificationEvents(run({ verdict: "failing" }))[0]!.event, "failure");
});

test("rate limits honor bounded retry-after, forbidden responses fail once, and disabling cancels pending delivery", async () => {
  let now = 1_000;
  const { value } = await service((async () => new Response("not stored", { status: 429, headers: { "retry-after": "999999" } })) as typeof fetch, () => now);
  await enable(value); await value.observe(run()); await value.drain();
  assert.equal(value.deliveries()[0]!.nextAttemptAt, now + 300_000);
  await value.update("fixture", { enabled: false, events: ["done"], projects: "all" });
  assert.equal(value.deliveries()[0]!.state, "cancelled");
  now += 500_000; await value.drain();
  const forbidden = await service((async () => new Response(environment.OUTBOUND_URL, { status: 403 })) as typeof fetch);
  await enable(forbidden.value); await forbidden.value.observe(run()); await forbidden.value.drain();
  assert.equal(forbidden.value.deliveries()[0]!.state, "failed");
  assert.equal(forbidden.value.deliveries()[0]!.attempts, 1);
  assert.doesNotMatch(JSON.stringify(forbidden.value.deliveries()), /private-url-path/);
});

test("Slack test deliveries use literal text, and a restart never silently repeats an uncertain send", async () => {
  let body: any;
  const { value, file } = await service((async (_url, options) => { body = JSON.parse(String(options!.body)); return new Response("ok"); }) as typeof fetch, undefined, [{ ...configuration[0], protocol: "slack" }]);
  const testDelivery = await value.test("fixture"); await value.drain();
  assert.equal(value.deliveries()[0]!.manual, true);
  assert.equal(body.blocks[0].text.type, "plain_text");
  assert.equal(body.unfurl_links, false);
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.deliveries[0].state = "sending";
  await writeFile(file, JSON.stringify(saved));
  let calls = 0;
  const restored = new Notifications({ file, environment, fetch: (async () => { calls++; return new Response("ok"); }) as typeof fetch }); services.push(restored); await restored.load([{ ...configuration[0], protocol: "slack" }]);
  assert.equal(restored.deliveries()[0]!.id, testDelivery.id);
  assert.equal(restored.deliveries()[0]!.state, "failed");
  assert.match(restored.deliveries()[0]!.reason!, /unknown after restart/);
  await restored.drain(); assert.equal(calls, 0);
});

test("invalid destinations remain disabled and corrupt state is preserved without sending", async () => {
  let calls = 0;
  const { value, file } = await service((async () => { calls++; return new Response("ok"); }) as typeof fetch);
  const invalid = new Notifications({ file: file + "-invalid", environment: { ...environment, OUTBOUND_URL: "http://insecure.invalid/" }, fetch: (async () => { calls++; return new Response("ok"); }) as typeof fetch }); services.push(invalid);
  await invalid.load(configuration);
  await assert.rejects(enable(invalid), /valid HTTPS/);
  await assert.rejects(() => invalid.test("fixture"), /valid HTTPS/);
  await writeFile(file, "{damaged");
  const restored = new Notifications({ file, environment, fetch: (async () => { calls++; return new Response("ok"); }) as typeof fetch }); services.push(restored);
  await assert.rejects(() => restored.load(configuration), /damaged/);
  await restored.observe(run()); await restored.drain();
  assert.equal(calls, 0);
  assert.equal(await readFile(file, "utf8"), "{damaged");
});

test("changing a secret destination URL requires renewed opt-in and cancels its old queue", async () => {
  const { value, file } = await service((async () => new Response("limited", { status: 429 })) as typeof fetch);
  await enable(value); await value.observe(run()); await value.drain();
  let calls = 0;
  const restored = new Notifications({ file, environment: { ...environment, OUTBOUND_URL: "https://different.fixture.invalid/new-secret" }, fetch: (async () => { calls++; return new Response("ok"); }) as typeof fetch }); services.push(restored);
  await restored.load(configuration);
  assert.equal(restored.list()[0]!.settings.enabled, false);
  assert.match(restored.list()[0]!.lastError!, /Destination changed/);
  await restored.drain();
  assert.equal(calls, 0);
  await enable(restored); await restored.observe(run({ id: "run-2" })); await restored.drain();
  assert.equal(calls, 1);
});

test("a queued disable takes precedence over a concurrent retry worker claim", async () => {
  let now = 1_000, calls = 0;
  const { value } = await service((async () => { calls++; return new Response("limited", { status: 429 }); }) as typeof fetch, () => now);
  await enable(value); await value.observe(run()); await value.drain();
  now = value.deliveries()[0]!.nextAttemptAt!;
  const disabling = value.update("fixture", { enabled: false, events: ["done"], projects: "all" });
  const draining = value.drain();
  await Promise.all([disabling, draining]);
  assert.equal(value.deliveries()[0]!.state, "cancelled");
  assert.equal(calls, 1, "a pending delivery cannot be claimed from an obsolete enabled snapshot");
});

test("credential redaction happens before the task title length limit", async () => {
  let title = "";
  const { value } = await service((async (_url, options) => { title = JSON.parse(String(options!.body)).title; return new Response("ok"); }) as typeof fetch);
  await enable(value); await value.observe(run({ task: "a".repeat(195) + environment.OUTBOUND_CREDENTIAL })); await value.drain();
  assert.equal(title, "a".repeat(195) + "[REDA");
  assert.doesNotMatch(title, /priva/);
});

test("standing team notifications are scoped, durable and quiet for no-ops and child runs", async () => {
  const requests: any[] = [];
  const { value, file } = await service((async (_url, options) => { requests.push(JSON.parse(String(options!.body))); return new Response("ok"); }) as typeof fetch);
  await enable(value);
  const team = { id: "pt-test", name: "Product team", projectId: "project-one", cycles: [{ id: "cycle-1", status: "completed", summary: "Ready" }], opportunities: [{ cycleId: "cycle-1", status: "ready" }] } as unknown as import("../src/project-team-model.js").ProjectTeam;
  await value.observeProjectTeam(team); await value.drain();
  assert.equal(requests.length, 1); assert.equal(requests[0].teamId, team.id); assert.equal(requests[0].cycleId, "cycle-1"); assert.equal(requests[0].runId, "");
  const restored = new Notifications({ file, environment, fetch: (async () => { throw new Error("Duplicate sent"); }) as typeof fetch }); services.push(restored); await restored.load(configuration);
  await restored.observeProjectTeam(team); assert.equal(restored.deliveries().length, 1);
  await value.observe(run({ projectTeam: { teamId: team.id } as RunSummary["projectTeam"] }));
  team.cycles[0]!.status = "no-op"; await value.observeProjectTeam(team); await value.drain(); assert.equal(requests.length, 1);
});
