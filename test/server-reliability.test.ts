// The server over HTTP: event streams (ids, replay on reconnect, ordering), webhooks answered at
// once, phone sign-in and sign-out, the network listener refusing this machine, and the session
// claim. Real servers on free ports with fake agents, gh and docker; never ports 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${instance.base}/api/health`, { headers: bearer }).then((r) => r.ok, () => false)) return instance;
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
    startServer({ FAKE_GH_STATE: ghState, CODEFLOW_LAN_ALLOW_LOCAL: "1" }),
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
  assert.match(hello.epoch, /^[0-9a-f]{12}$/);
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
});

test("a run's stream: its history in order with ids, before any live event, and a reconnect replays only newer events", async () => {
  const started = await api(a, "/api/runs", { pattern: "pipeline", task: "Stream me too", repo, roles: team });
  const id = started.body.id;
  // Connected while it runs: history and live events interleave on the server, never on the wire.
  const events = await readEvents(`${a.base}/api/runs/${id}/events`, bearer, (e) => e.some((x) => x.data.type === "run" && x.data.run.endedAt));
  assert.deepEqual(events[0]!.data, { type: "hello", epoch: events[1]!.id!.split(":")[0], resumed: false });
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
  assert.deepEqual(replay[0], { type: "hello", epoch: feed.epoch, resumed: false });
  assert.equal(replay.filter((d) => d.type === "run").length, 1, "only the latest snapshot of the run");
  const steps = replay.filter((d) => d.type === "step").map((d) => d.step.id);
  assert.ok(steps.length > 0);
  assert.deepEqual(steps, [...new Set(steps)], "and of each step");
  assert.ok(replay.some((d) => d.type === "agent"), "with what the agents said");
  assert.deepEqual(await streams(), { streams: before.streams + 1, subscriptions: before.subscriptions + 2 });

  // The same run picked up where it left off, a run and a terminal that don't exist, and the first subscription dropped.
  const last = Math.max(...replay.filter((d) => d.seq).map((d) => d.seq));
  const changed = await hub.update({ subscribe: [{ id: 3, topic: `run:${id}`, after: `${feed.epoch}:${last}` }, { id: 4, topic: "run:no-such-run" }, { id: 5, topic: "shell:no-such-shell" }], unsubscribe: [2] });
  assert.equal(changed.status, 200);
  await hub.until(() => [3, 4, 5].every((n) => hub.of(n).length > 0), "the new subscriptions");
  assert.deepEqual(hub.of(3), [{ type: "hello", epoch: feed.epoch, resumed: true }], "resumed, with nothing missed");
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
