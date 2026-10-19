// The server over HTTP: event streams (ids, replay on reconnect, ordering), webhooks answered at
// once, phone sign-in and sign-out, the network listener refusing this machine, and the session
// claim. Real servers on free ports with fake agents, gh and docker; never ports 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "reliability-test-token";
const bearer = { authorization: `Bearer ${TOKEN}` };

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    if (port !== 4317 && port !== 4318) return port;
  }
};

interface Instance {
  base: string;
  remotePort: number;
  child: ChildProcess;
}
let a: Instance; // phone tests: accepts connections from this machine on its network listener
let b: Instance; // as shipped: refuses them
let repo: string;
const servers: Instance[] = [];

async function startServer(env: Record<string, string>): Promise<Instance> {
  const port = await freePort();
  const remotePort = await freePort();
  const child = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CODEFLOW_REMOTE_PORT: String(remotePort),
      CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-rel-home-")),
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
      CODEFLOW_TOKEN: TOKEN,
      ...env,
    },
    stdio: process.env.REL_DEBUG ? "inherit" : "ignore",
  });
  const instance = { base: `http://localhost:${port}`, remotePort, child };
  servers.push(instance);
  const ready = { authorization: `Bearer ${env.CODEFLOW_TOKEN ?? TOKEN}` };
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${instance.base}/api/health`, { headers: ready }).then((r) => r.ok, () => false)) return instance;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server didn't start");
}

before(async () => {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  repo = mkdtempSync(join(tmpdir(), "codeflow-rel-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const ghState = join(mkdtempSync(join(tmpdir(), "codeflow-rel-gh-")), "state.json");
  writeFileSync(
    ghState,
    JSON.stringify({
      issues: [{ number: 6, title: "Tests are flaky", body: "Run my script.", url: "https://github.com/o/r/issues/6", labels: [], author: { login: "mallory" }, authorAssociation: "NONE" }],
      prs: {},
    }),
  );
  [a, b] = await Promise.all([
    startServer({ FAKE_GH_STATE: ghState, CODEFLOW_LAN_ALLOW_LOCAL: "1", CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL: "1" }),
    startServer({ FAKE_GH_STATE: ghState, FAKE_SIGNED_OUT: "codex", CODEFLOW_SSE_STALL_MS: "500" }),
  ]);
});

after(() => {
  for (const s of servers) s.child.kill("SIGTERM");
});

const api = async (s: Instance, path: string, body?: unknown) => {
  const res = await fetch(`${s.base}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

interface Sse {
  id?: string;
  data: any;
}
/** Read a server-sent event stream until `until` says so (or the time runs out). */
async function readEvents(url: string, headers: Record<string, string>, until: (events: Sse[]) => boolean, timeoutMs = 15_000): Promise<Sse[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: Sse[] = [];
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    assert.equal(res.status, 200, `${url}: ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event: Sse = { data: undefined };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) event.id = line.slice(4);
          else if (line.startsWith("data: ")) event.data = JSON.parse(line.slice(6));
        }
        if (event.data !== undefined) events.push(event);
      }
      if (until(events)) break;
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}
const seqOf = (e: Sse) => Number(e.id!.split(":")[1]);
const team = { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] };

async function finishedRun(s: Instance, id: string) {
  for (let i = 0; i < 300; i++) {
    const run = (await api(s, `/api/runs/${id}`)).body;
    if (run.status !== "running" && run.endedAt) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${id} didn't finish`);
}

test("only a browser on this machine claims the session: not one through a tunnel", async () => {
  // A tunnel forwarding to this port rewrites Host to localhost, but adds forwarding headers.
  const tunnelled = await fetch(`${a.base}/`, { headers: { "x-forwarded-for": "198.51.100.4" } });
  assert.equal(tunnelled.status, 401);
  assert.equal(tunnelled.headers.get("set-cookie"), null);
  const local = await fetch(`${a.base}/`);
  assert.equal(local.status, 200);
  assert.match(local.headers.get("set-cookie") ?? "", /^codeflow_session=/);
});

test("a cookie of the same name a page on another port set (a narrower path, so sent first) doesn't sign you out", async () => {
  // Cookies ignore ports: an app in the Browser's preview can set one, though not replace the real one.
  const shadowed = await fetch(`${a.base}/api/patterns`, { headers: { cookie: `codeflow_session=planted; codeflow_session=${TOKEN}` } });
  assert.equal(shadowed.status, 200);
  assert.equal((await fetch(`${a.base}/api/patterns`, { headers: { cookie: "codeflow_session=planted" } })).status, 401, "a planted one alone signs nobody in");
  assert.equal((await fetch(`${a.base}/api/patterns`, { headers: { cookie: "codeflow_session=" } })).status, 401);
});

test("a cookie jar another app on localhost filled up doesn't lock you out: code-flow still reads it, and the token link still works", async () => {
  // 30 cookies of nearly 4 KB: far over Node's default 16 KB of headers.
  const junk = Array.from({ length: 30 }, (_, i) => `pad${i}=${"A".repeat(3900)}`).join("; ");
  const port = Number(new URL(a.base).port);
  const status = (path: string, cookie: string) =>
    new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}`, cookie } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
  assert.equal(await status("/api/patterns", `${junk}; codeflow_session=${TOKEN}`), 200);
  assert.equal(await status(`/?token=${TOKEN}`, junk), 302, "the sign-in link gets through");
});

test("/api/events: a hello with the server's epoch and every run, ids on every event, and a reconnect gets only what it missed", async () => {
  const first = await readEvents(`${a.base}/api/events`, bearer, (e) => e.length >= 1);
  const hello = first[0]!.data;
  assert.equal(hello.type, "hello");
  assert.match(hello.epoch, /^[0-9a-f]{12}-fs\d+-history\d+$/, "feed identity includes server, filesystem-policy and deletion generations");
  assert.ok(Array.isArray(hello.runs), "a first connection gets the whole list");
  assert.equal(first[0]!.id, `${hello.epoch}:${hello.seq}`);

  // Watch a run start and finish.
  let runId = "";
  const watching = readEvents(`${a.base}/api/events`, bearer, (e) => e.some((x) => x.data.type === "run" && x.data.run.id === runId && x.data.run.status !== "running"));
  await new Promise((r) => setTimeout(r, 300));
  const started = await api(a, "/api/runs", { pattern: "pipeline", task: "Stream me", repo, roles: team });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  runId = started.body.id;
  const live = (await watching).filter((e) => e.data.type === "run");
  assert.ok(live.length >= 2);
  const seqs = live.map(seqOf);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "in order");
  assert.ok(live.every((e) => e.id!.startsWith(`${hello.epoch}:`) && e.data.seq === seqOf(e)));

  // Reconnecting after the first of them: the hello says it resumed, then only the newer ones.
  const from = live[0]!;
  const resumed = await readEvents(`${a.base}/api/events`, { ...bearer, "last-event-id": from.id! }, (e) => e.length >= live.length);
  assert.equal(resumed[0]!.data.type, "hello");
  assert.equal(resumed[0]!.data.resumed, true);
  assert.equal(resumed[0]!.data.runs, undefined);
  assert.ok(resumed.slice(1).every((e) => seqOf(e) > seqOf(from)));
  assert.ok(resumed.slice(1).some((e) => e.data.run.id === runId && e.data.run.status !== "running"), "what it missed is replayed");
  // An id from another server start (it restarted) gets the whole list again.
  const restarted = await readEvents(`${a.base}/api/events`, { ...bearer, "last-event-id": "0123456789ab:3" }, (e) => e.length >= 1);
  assert.ok(Array.isArray(restarted[0]!.data.runs));
  assert.ok(restarted[0]!.data.runs.some((r: { id: string }) => r.id === runId));
  await finishedRun(a, runId);
  const deleted = await fetch(`${a.base}/api/runs/${runId}`, { method: "DELETE", headers: bearer });
  assert.equal(deleted.status, 200, await deleted.text());
  const afterDelete = await readEvents(`${a.base}/api/events`, { ...bearer, "last-event-id": from.id! }, e => e.length >= 1);
  assert.notEqual(afterDelete[0]!.data.resumed, true, "deletion replaces stale client history on reconnect");
  assert.notEqual(afterDelete[0]!.data.epoch, hello.epoch);
  assert.ok(!afterDelete[0]!.data.runs.some((r: { id: string }) => r.id === runId));
});

test("a run's stream: its history in order with ids, before any live event, and a reconnect replays only newer events", async () => {
  const started = await api(a, "/api/runs", { pattern: "pipeline", task: "Stream me too", repo, roles: team });
  const id = started.body.id;
  // Connected while it runs: history and live events interleave on the server, never on the wire.
  const events = await readEvents(`${a.base}/api/runs/${id}/events`, bearer, (e) => e.some((x) => x.data.type === "run" && x.data.run.endedAt));
  // A fresh connection also gets the snapshot: the client never depends on the event log holding the latest state.
  const hello = events[0]!.data;
  assert.deepEqual({ type: hello.type, epoch: hello.epoch, resumed: hello.resumed }, { type: "hello", epoch: events[1]!.id!.split(":")[0], resumed: false });
  assert.equal(hello.snapshot?.run?.id, id);
  assert.ok(Array.isArray(hello.snapshot?.steps) && Number.isInteger(hello.snapshot?.seq));
  const body = events.slice(1);
  const seqs = body.map(seqOf);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), `strictly increasing: ${seqs.join(",")}`);
  assert.ok(body.every((e) => e.data.seq === seqOf(e)));
  await finishedRun(a, id);

  const all = await readEvents(`${a.base}/api/runs/${id}/events`, bearer, (e) => e.some((x) => x.data.type === "run" && x.data.run.endedAt && x.data.seq >= seqs.at(-1)!));
  const middle = all[Math.floor(all.length / 2)]!;
  const again = await readEvents(`${a.base}/api/runs/${id}/events`, { ...bearer, "last-event-id": middle.id! }, (e) => e.length >= all.length - all.indexOf(middle));
  assert.equal(again[0]!.data.resumed, true);
  assert.ok(again.length > 1);
  assert.ok(again.slice(1).every((e) => seqOf(e) > seqOf(middle)), "only what came after");

  assert.equal((await fetch(`${a.base}/api/runs/no-such-run/events`, { headers: bearer })).status, 404);
});

/** A window's one stream (/api/stream): its messages as they come, by subscription. */
async function openHub(s: Instance, subs: unknown[]) {
  const ac = new AbortController();
  const res = await fetch(`${s.base}/api/stream?subs=${encodeURIComponent(JSON.stringify(subs))}`, { headers: bearer, signal: ac.signal });
  assert.equal(res.status, 200);
  const messages: { s: number; d: any }[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          for (const line of buffer.slice(0, i).split("\n")) if (line.startsWith("data: ")) messages.push(JSON.parse(line.slice(6)));
          buffer = buffer.slice(i + 2);
        }
      }
    } catch {
      // closed
    }
  })();
  const until = async (cond: () => boolean, what: string, ms = 15_000) => {
    for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  await until(() => messages.length > 0, "the hello");
  const client: string = messages[0]!.d.client;
  return {
    messages,
    client,
    until,
    of: (id: number) => messages.filter((m) => m.s === id).map((m) => m.d),
    update: (body: unknown) => api(s, `/api/stream/${client}`, body),
    close: () => ac.abort(),
  };
}

test("/api/stream: one stream for every topic a window watches, changed while it's open; a run replays only its latest snapshots", async () => {
  const started = await api(a, "/api/runs", { pattern: "pipeline", task: "One stream", repo, roles: team });
  const id = started.body.id;
  await finishedRun(a, id);
  const streams = async () => (await api(a, "/api/health")).body.streams as { streams: number; subscriptions: number };
  const before = await streams();
  const hub = await openHub(a, [{ id: 1, topic: "runs" }, { id: 2, topic: `run:${id}` }]);
  assert.deepEqual(hub.messages[0], { s: 0, d: { type: "hello", client: hub.client } });
  await hub.until(() => hub.of(2).some((d) => d.type === "run" && d.run.endedAt), "the run's snapshot");
  const feed = hub.of(1)[0];
  assert.equal(feed.type, "hello");
  assert.ok(feed.runs.some((r: { id: string }) => r.id === id), "the run list starts whole");
  const replay = hub.of(2);
  const { snapshot, ...hello } = replay[0];
  assert.deepEqual(hello, { type: "hello", epoch: `run-${id}`, resumed: false });
  assert.equal(snapshot.run.id, id, "the run as it is now comes first");
  assert.equal(replay.filter((d) => d.type === "run").length, 1, "only the latest snapshot of the run");
  const steps = replay.filter((d) => d.type === "step").map((d) => d.step.id);
  assert.ok(steps.length > 0);
  assert.deepEqual(steps, [...new Set(steps)], "and of each step");
  assert.ok(replay.some((d) => d.type === "agent"), "with what the agents said");
  assert.deepEqual(await streams(), { streams: before.streams + 1, subscriptions: before.subscriptions + 2 });

  // The same run picked up where it left off, a run and a terminal that don't exist, and the first subscription dropped.
  const last = Math.max(...replay.filter((d) => d.seq).map((d) => d.seq));
  const changed = await hub.update({ subscribe: [{ id: 3, topic: `run:${id}`, after: `run-${id}:${last}` }, { id: 4, topic: "run:no-such-run" }, { id: 5, topic: "shell:no-such-shell" }], unsubscribe: [2] });
  assert.equal(changed.status, 200);
  await hub.until(() => [3, 4, 5].every((n) => hub.of(n).length > 0), "the new subscriptions");
  assert.deepEqual(hub.of(3).map(({ snapshot: _, ...d }) => d), [{ type: "hello", epoch: `run-${id}`, resumed: true }], "resumed, with nothing missed");
  assert.deepEqual([hub.of(4)[0].type, hub.of(4)[0].status], ["error", 404]);
  assert.match(hub.of(5)[0].message, /terminal is gone/);
  assert.deepEqual(await streams(), { streams: before.streams + 1, subscriptions: before.subscriptions + 2 }, "runs, and the run again");

  // A new run comes on the run list's topic, on the same stream.
  const next = await api(a, "/api/runs", { pattern: "pipeline", task: "One stream, two", repo, roles: team });
  await hub.until(() => hub.of(1).some((d) => d.type === "run" && d.run.id === next.body.id && d.run.endedAt), "the new run's end");
  assert.equal(hub.of(2).length, replay.length, "nothing more for the dropped subscription");

  // Closed, its subscriptions go; its id no longer changes anything.
  hub.close();
  for (let i = 0; i < 100 && (await streams()).streams !== before.streams; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await streams(), before);
  assert.equal((await api(a, `/api/stream/${hub.client}`, { unsubscribe: [1] })).status, 404);
  assert.equal((await fetch(`${a.base}/api/stream?subs=not-json`, { headers: bearer })).status, 400);
});

test("a run's durable cursor survives server restart and invalid future cursors reset", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeflow-cursor-home-"));
  const first = await startServer({ CODEFLOW_HOME: home });
  const started = await api(first, "/api/runs", { pattern: "pipeline", task: "Persistent cursor", repo, roles: team });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.id;
  await finishedRun(first, id);
  const events = await readEvents(`${first.base}/api/runs/${id}/events`, bearer, (items) => items.some((item) => item.data.type === "run" && item.data.run.endedAt));
  const cursor = events[Math.floor(events.length / 2)]!;
  const stopped = new Promise((resolve) => first.child.once("exit", resolve));
  first.child.kill("SIGTERM");
  await stopped;
  const second = await startServer({ CODEFLOW_HOME: home });
  const replay = await readEvents(`${second.base}/api/runs/${id}/events`, { ...bearer, "last-event-id": cursor.id! }, (items) => items.some((item) => item.data.type === "run" && item.data.run.endedAt));
  assert.equal(replay[0]!.data.resumed, true);
  assert.equal(replay[0]!.data.epoch, events[0]!.data.epoch);
  assert.ok(replay.slice(1).every((event) => seqOf(event) > seqOf(cursor)));
  const reset = await readEvents(`${second.base}/api/runs/${id}/events`, { ...bearer, "last-event-id": `${events[0]!.data.epoch}:9007199254740991` }, (items) => !!items.length);
  assert.equal(reset[0]!.data.resumed, false);
});

test("a webhook is answered at once and the run starts in the background; GitHub sending a delivery again starts nothing", async () => {
  const created = await api(a, "/api/automations", { name: "Hook", webhook: true, run: { repo, pattern: "pipeline", task: "Hooked chore", roles: team } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hook = (delivery: string) =>
    fetch(`${a.base}/hooks/${created.body.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.body.token}`, "content-type": "application/json", "x-github-delivery": delivery },
      body: JSON.stringify({ details: "from CI" }),
    });
  const t0 = Date.now();
  const fired = await hook("delivery-1");
  assert.equal(fired.status, 202);
  assert.deepEqual(await fired.json(), { accepted: true, automation: created.body.id });
  assert.ok(Date.now() - t0 < 3_000, "answered before the run started");
  const replay = await hook("delivery-1");
  assert.equal(replay.status, 200);
  assert.match((await replay.json()).ignored, /already handled/);

  let automation: any;
  for (let i = 0; i < 100 && !automation?.lastRunId; i++) {
    automation = (await api(a, "/api/automations")).body.find((x: { id: string }) => x.id === created.body.id);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(automation.lastRunId, "the run started");
  assert.deepEqual(automation.deliveries, ["delivery-1"]);
  await finishedRun(a, automation.lastRunId);
});

test("phone: the read-only link never signs in, the sign-in link has its own secret, cookies last 30 days, and turning anything off signs phones out", async () => {
  const PHONE = `http://127.0.0.1:${a.remotePort}`;
  const info = (await api(a, "/api/remote", { enabled: true, lan: true, control: true })).body;
  assert.notEqual(info.phonePath, info.path);
  assert.equal(info.lanError, undefined);

  const readOnly = await fetch(`${PHONE}${info.path}`, { redirect: "manual" });
  assert.equal(readOnly.status, 200, "the read-only link shows the read-only view, even with full control on");
  assert.equal(readOnly.headers.get("set-cookie"), null);
  assert.doesNotMatch(await readOnly.text(), /<button|<form/);

  const signIn = await fetch(`${PHONE}${info.phonePath}`, { redirect: "manual" });
  assert.equal(signIn.status, 200, "a page that moves on by itself, not a redirect (see signingInPage)");
  assert.match(await signIn.text(), /location\.replace\("\/"\)/);
  const setCookie = signIn.headers.get("set-cookie")!;
  assert.match(setCookie, /Max-Age=2592000/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal((await fetch(`${PHONE}/api/runs`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${a.base}${info.phonePath}`)).status, 404, "the sign-in link only works on the network listener");

  // Off and on again: the old cookie doesn't come back to life.
  await api(a, "/api/remote", { control: false });
  const again = (await api(a, "/api/remote", { control: true })).body;
  assert.notEqual(again.phonePath, info.phonePath);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await fetch(`${PHONE}/api/runs`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${PHONE}${info.phonePath}`, { redirect: "manual" })).status, 404);
  // Turning the Wi-Fi listener off makes a new read-only link too.
  const offLan = (await api(a, "/api/remote", { lan: false })).body;
  assert.notEqual(offLan.path, info.path);
  assert.equal((await fetch(`${a.base}${info.path}`)).status, 404);
  await api(a, "/api/remote", { enabled: false });
});

test("Run app on a locked-down run asks first: it would run an outsider's code on this machine", async () => {
  const started = await api(a, "/api/runs", { pattern: "pipeline", task: "Fix issue #6", repo, roles: team, source: { kind: "issue", number: 6 }, loop: { check: "true" } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const run = await finishedRun(a, started.body.id);
  assert.match(run.lockdown, /Issue #6 comes from @mallory/);
  const serve = `/api/runs/${run.id}/worktrees/${encodeURIComponent(run.worktrees[0].name)}/serve`;
  const refused = await api(a, serve, { command: "sleep 30" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.confirm, "allowUntrusted");
  assert.match(refused.body.error, /outside any sandbox/);
  const allowed = await api(a, serve, { command: "sleep 30", allowUntrusted: true });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  await fetch(`${a.base}${serve}`, { method: "DELETE", headers: bearer });
});

test("the network listener refuses this machine's own programs; a port that's taken shows instead of a QR code", async () => {
  const info = (await api(b, "/api/remote", { enabled: true, lan: true })).body;
  assert.equal(info.lanError, undefined);
  assert.ok(info.lanUrls.length > 0 || Object.values(networkInterfaces()).flat().every((i) => !i || i.internal || i.family !== "IPv4"));
  // From loopback, and from this machine's own Wi-Fi address: the connection is dropped.
  const own = [`127.0.0.1`, ...Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address)];
  for (const ip of own) {
    await assert.rejects(fetch(`http://${ip}:${b.remotePort}${info.path}`), `refused from ${ip}`);
  }
  await api(b, "/api/remote", { lan: false });

  // Another program has the port now. code-flow lets go of it just after replying (the phone may
  // be the one turning itself off), so take it once it's free rather than racing the close.
  const squatter = await listenWhenFree(b.remotePort);
  try {
    const taken = (await api(b, "/api/remote", { lan: true })).body;
    assert.match(taken.lanError, new RegExp(`Port ${b.remotePort} is already in use`));
    assert.deepEqual(taken.lanUrls, [], "no QR code pointing at another program");
    assert.match((await api(b, "/api/remote")).body.lanError, /already in use/);
  } finally {
    squatter.close();
  }
  const off = (await api(b, "/api/remote", { lan: false, enabled: false })).body;
  assert.equal(off.lanError, undefined);
});

/** Listen on a port as soon as whoever has it lets go (up to about two seconds). */
async function listenWhenFree(port: number): Promise<Server> {
  for (let attempt = 0; ; attempt++) {
    const server = createServer((s) => s.end("not code-flow"));
    const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once("listening", () => resolve(undefined));
      server.once("error", resolve);
      server.listen(port, "0.0.0.0");
    });
    if (!error) return server;
    if (error.code !== "EADDRINUSE" || attempt >= 40) throw error;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the health check tells Auto when an agent is signed out", async () => {
  const first = (await api(b, "/api/doctor")).body;
  assert.equal(first.find((e: { id: string }) => e.id === "codex").signedIn, false);
  const second = (await api(b, "/api/doctor")).body;
  assert.equal(second.find((e: { id: string }) => e.id === "codex").quota?.status, "signed_out");
  assert.notEqual(second.find((e: { id: string }) => e.id === "claude").quota?.status, "signed_out");
});

test("a filesystem-policy generation invalidates an old feed cursor and sends a fresh authorized snapshot", async () => {
  const initial = (await readEvents(`${b.base}/api/events?limit=100`, bearer, (events) => events.length > 0))[0]!;
  const created = await api(b, "/api/projects", { name: "Policy generation fixture", repos: [repo] }); assert.equal(created.status, 201);
  const changed = await fetch(`${b.base}/api/projects/${created.body.id}/filesystem-policy`, { method: "PUT", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ revision: 0, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }) }); assert.equal(changed.status, 200, await changed.text());
  const refreshed = (await readEvents(`${b.base}/api/events?limit=100`, { ...bearer, "last-event-id": initial.id! }, (events) => events.length > 0))[0]!;
  assert.notEqual(refreshed.data.epoch, initial.data.epoch); assert.equal(refreshed.data.epoch.split("-fs")[0], initial.data.epoch.split("-fs")[0], "the instance remains the same while its authorization generation changes"); assert.equal(Number(refreshed.data.epoch.split("-fs")[1]), Number(initial.data.epoch.split("-fs")[1]) + 1);
  assert.ok(Array.isArray(refreshed.data.runs)); assert.notEqual(refreshed.data.resumed, true, "a cursor from an earlier policy must never preserve old visible results"); assert.equal(refreshed.id, `${refreshed.data.epoch}:${refreshed.data.seq}`);
});

test("Improve rewrites the task in one read-only turn: Auto picks the agent, bad input is refused, the repository is untouched", async () => {
  const status = () => execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
  const before = status();
  const quick = await api(a, "/api/improve-prompt", { text: "add rate limit to login", repo, context: ["src/login.ts"], source: { kind: "issue", number: 6, title: "Tests are flaky" } });
  assert.equal(quick.status, 200, JSON.stringify(quick.body));
  assert.deepEqual(quick.body, { prompt: "Goal: add rate limit to login\n\nDone when: the tests pass.", summary: "Stated the goal and when it's done (quick, claude). Context: text only; empty private repository.", agent: "claude" });
  const deep = await api(a, "/api/improve-prompt", { text: "add rate limit to login", repo, mode: "repo", agent: "agy" });
  assert.equal(deep.status, 200, JSON.stringify(deep.body));
  assert.equal(deep.body.agent, "agy");
  assert.match(deep.body.summary, /\(repo, agy\)/);
  assert.equal(status(), before);

  const refused = async (body: Record<string, unknown>, message: RegExp, code = 400) => {
    const res = await api(a, "/api/improve-prompt", body);
    assert.equal(res.status, code, JSON.stringify(res.body));
    assert.match(res.body.error, message);
  };
  await refused({ text: "  ", repo }, /Write a task to improve first/);
  await refused({ text: "x".repeat(20_001), repo }, /too long to improve/);
  await refused({ text: "x", repo: "relative/path" }, /absolute path/);
  await refused({ text: "x", repo: tmpdir() }, /Not a git repository/);
  await refused({ text: "IMPROVE-EMPTY", repo }, /didn't return a rewritten task/, 502);
});

test("Improve holds repository and policy leases during a delayed turn, and explicit remote/container profiles never launch a native fallback", { timeout: 60_000 }, async () => {
  const records = mkdtempSync(join(tmpdir(), "codeflow-improve-lease-records-"));
  const instance = await startServer({ FAKE_SLEEP_MS: "60000", FAKE_SLEEP_VENDOR: "claude", FAKE_RECORD_DIR: records });
  const stop = new AbortController(); let turn: Promise<unknown> | undefined;
  const waitFor = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + 10_000; while (!await check()) { if (Date.now() > end) throw new Error("Improve lease fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); } };
  try {
    for (const profile of [{ execution: "remote" }, { execution: "container" }, { remoteWorker: { workerId: "fixture", repoMapping: "repo" } }, { agentContainer: { image: "fixture:prepared" } }, { loop: { remoteWorker: { workerId: "fixture", repoMapping: "repo" } } }, { loop: { agentContainer: { image: "fixture:prepared" } } }]) {
      const refused = await api(instance, "/api/improve-prompt", { text: "No fallback", repo, agent: "claude", ...profile }); assert.equal(refused.status, 400, JSON.stringify(refused.body)); assert.match(refused.body.error, /local execution only|cannot fall back/);
    }
    assert.deepEqual(readdirSync(records), [], "unsupported profiles are rejected before any native provider turn");
    const project = await api(instance, "/api/projects", { name: "Improve lease fixture", repos: [repo] }); assert.equal(project.status, 201, JSON.stringify(project.body));
    const path = `/api/workspace/file?repo=${encodeURIComponent(repo)}&path=README.md`, original = await api(instance, path); assert.equal(original.status, 200);
    turn = fetch(`${instance.base}/api/improve-prompt`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ text: "SNEAKY Improve lease fixture", repo, agent: "claude", mode: "repo" }), signal: stop.signal }).then(async (response) => ({ status: response.status, body: await response.json() }));
    void turn.catch(() => undefined);
    await waitFor(() => readdirSync(records).length > 0 && existsSync(join(JSON.parse(readFileSync(join(records, readdirSync(records)[0]!), "utf8")).cwd, "sneaky.txt")));
    const calls = readdirSync(records).map((name) => JSON.parse(readFileSync(join(records, name), "utf8"))); assert.equal(calls.length, 1); assert.equal(calls[0].vendor, "claude"); assert.match(calls[0].prompt, /Rewrite the task below/);
    const activity = (await api(instance, "/api/health")).body.activity; assert.ok(activity.leases.some((lease: { kind: string; repo: string }) => lease.kind === "prompt improvement" && lease.repo === realpathSync(repo)), "the delayed provider turn holds the canonical repository lease");
    const edit = await api(instance, "/api/workspace/file", { repo, path: "README.md", text: "Must not overwrite\n", expectedHash: original.body.hash }); assert.equal(edit.status, 409, JSON.stringify(edit.body)); assert.match(edit.body.error, /prompt improvement/);
    const started = await api(instance, "/api/runs", { pattern: "pipeline", task: "Must not start beside Improve", repo, roles: team, loop: { check: "true", setup: "", copy: [] } }); assert.equal(started.status, 409, JSON.stringify(started.body)); assert.match(started.body.error, /prompt improvement/);
    const policy = await fetch(`${instance.base}/api/projects/${project.body.id}/filesystem-policy`, { method: "PUT", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ revision: 0, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }) }); assert.equal(policy.status, 409, await policy.text()); assert.equal((await api(instance, `/api/projects/${project.body.id}/filesystem-policy`)).body.revision, 0, "the policy is not committed while an improvement can execute or restore files");
    assert.equal(readdirSync(records).length, 1, "neither the refused run nor unsupported profiles dispatched another provider");
    stop.abort(); await assert.rejects(turn, (error: Error) => error.name === "AbortError");
    await waitFor(async () => !(await api(instance, "/api/health")).body.activity.leases.length && !existsSync(calls[0].cwd));
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), original.body.text, "private cleanup never touches the original checkout"); assert.equal(existsSync(join(repo, "sneaky.txt")), false);
    const saved = await api(instance, "/api/workspace/file", { repo, path: "README.md", text: original.body.text, expectedHash: original.body.hash }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  } finally { stop.abort(); await turn?.catch(() => undefined); await waitFor(async () => !(await api(instance, "/api/health")).body.activity.leases.length).catch(() => undefined); instance.child.kill("SIGTERM"); }
});

test("Improve refuses relative PATH before source Git validation can execute a committed impostor", { timeout: 45_000 }, async () => {
  const source = mkdtempSync(join(tmpdir(), "codeflow-improve-path-repo-")), marker = join(source, "IMPOSTOR_EXECUTED"), records = mkdtempSync(join(tmpdir(), "codeflow-improve-path-records-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source }); writeFileSync(join(source, "README.md"), "fixture\n"); writeFileSync(join(source, "git"), `#!/bin/sh\nprintf 'bad' > '${marker.replace(/'/g, "'\\''")}'\nexit 1\n`, { mode: 0o700 }); execFileSync("git", ["add", "."], { cwd: source }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "impostor"], { cwd: source });
  const instance = await startServer({ PATH: `.:${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_RECORD_DIR: records });
  try {
    for (const prefix of ["/api", "/api/v1"]) {
      const refused = await api(instance, `${prefix}/improve-prompt`, { text: "Rewrite safely", repo: source, agent: "claude", mode: "repo" }); assert.equal(refused.status, 400, JSON.stringify(refused.body)); assert.match(refused.body.error, /PATH/);
      const unknown = await api(instance, `${prefix}/improve-prompt/extra`, { text: "Rewrite safely", repo: source }); assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
      const read = await api(instance, `${prefix}/improve-prompt?repo=${encodeURIComponent(source)}`); assert.equal(read.status, 404, JSON.stringify(read.body));
    }
    assert.equal(existsSync(marker), false, "repository discovery must not execute source/git before environment validation"); assert.deepEqual(readdirSync(records), [], "no provider fallback executes");
  }
  finally { instance.child.kill("SIGTERM"); }
});

test("an owner token shaped like a runner credential still signs in on this machine, and an unknown runner credential still does not", async () => {
  const token = `tr-${randomBytes(32).toString("base64url")}`; assert.match(token, /^tr-[A-Za-z0-9_-]{43}$/, "the fixture token has the runner-credential shape");
  const instance = await startServer({ CODEFLOW_TOKEN: token });
  try {
    const self = await fetch(`${instance.base}/api/auth/self`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(self.status, 200); assert.equal((await self.json()).kind, "owner", "the owner token is matched before the bearer is read as a runner credential");
    assert.equal((await fetch(`${instance.base}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const stranger = await fetch(`${instance.base}/api/health`, { headers: { authorization: `Bearer tr-${randomBytes(32).toString("base64url")}` } }); assert.equal(stranger.status, 401); assert.match((await stranger.json()).error, /runner credential is not valid/);
    const other = await fetch(`${instance.base}/api/health`, { headers: bearer }); assert.equal(other.status, 401, "another instance's owner token is still refused");
  } finally { instance.child.kill("SIGTERM"); }
});
