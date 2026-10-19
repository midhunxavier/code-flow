import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import type { Shells, ShellInfo, ShellEvent } from "../src/shell.js";
import type { SharedUser } from "../src/shared-accounts.js";
import type { TeamTerminalOptions } from "../src/collab/terminals.js";
import type { CollabActor } from "../src/collab/model.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-team-terminals-")));
process.env.CODEFLOW_HOME = join(root, "home");
const { TeamTerminals, handleTeamTerminals, TERMINAL_IDLE_MS } = await import("../src/collab/terminals.js");
const { CollabError } = await import("../src/collab/model.js");
const { memberActor, ownerActor } = await import("../src/collab/store.js");
const owner = ownerActor(), services: InstanceType<typeof TeamTerminals>[] = [];
after(async () => { for (const service of services) await service.close(); rmSync(root, { recursive: true, force: true }); });
const status = (code: number) => (error: unknown) => error instanceof CollabError && error.status === code;
let count = 0;
async function fixture() {
  const dir = join(root, String(++count)), repo = join(dir, "repo"), file = join(dir, "access.json"); mkdirSync(repo, { recursive: true });
  const users: SharedUser[] = ["alice", "bob"].map((name) => ({ id: `u-${name}`, username: name, displayName: name, enabled: true, revision: 1, roles: { "p-1": "contributor" }, createdAt: 1, updatedAt: 1 }));
  const alice = memberActor({ ...users[0]!, userId: users[0]!.id }, "browser"), bob = memberActor({ ...users[1]!, userId: users[1]!.id }, "browser");
  assert.ok(alice.kind === "member" && bob.kind === "member");
  const running = new Map<string, ShellInfo>(), inputs: unknown[] = [], closed: string[] = [], callbacks = new Map<string, (e: ShellEvent) => void>();
  let starts = 0, now = 1000, backlog = 0, onOpen = () => {}, onProbe = () => {}, interactive = true;
  const shells = {
    interactive: async () => { onProbe(); return interactive; },
    async open(cwd: string, size: { cols: number; rows: number }) { const shell: ShellInfo = { id: `shell-${++starts}`, cwd, shell: "/bin/sh", status: "running", startedAt: now, busy: false, interactive, ...size }; running.set(shell.id, shell); onOpen(); return shell; },
    type: (id: string, data: string, encoding: string) => { inputs.push({ id, data, encoding }); return running.has(id); },
    resize: (id: string, cols: number, rows: number) => { const s = running.get(id); if (s) Object.assign(s, { cols, rows }); return !!s; },
    pendingInputBytes: () => backlog, get: (id: string) => running.get(id),
    close: (id: string) => { closed.push(id); running.delete(id); }, closeAll: () => running.clear(),
    subscribe: (id: string, fn: (e: ShellEvent) => void) => { callbacks.set(id, fn); return () => { callbacks.delete(id); }; },
    history: () => [{ type: "output", text: "private output" }],
  } as unknown as Shells;
  const options: TeamTerminalOptions = { users: () => users, projectRepos: (p) => p === "p-1" ? [repo] : undefined, resolveRepo: (p, r) => p === "p-1" && r === "app" ? repo : undefined, enabled: () => true, changed: () => {}, file, shells, now: () => now };
  const service = new TeamTerminals(options); services.push(service); await service.load();
  const configure = (userIds = users.map((u) => u.id), enabled = true) => service.configure({ revision: service.view(owner).revision, grant: { projectId: "p-1", userIds, enabled } });
  const open = (actor: CollabActor = alice, authorize = () => {}) => service.open(actor, { projectId: "p-1", repository: "app", cols: 80, rows: 24 }, authorize);
  return { service, options, users, alice, bob, file, running, inputs, callbacks, closed, configure, open, starts: () => starts, advance: (ms: number) => { now += ms; }, backlog: (n: number) => { backlog = n; }, onOpen: (fn: () => void) => { onOpen = fn; }, onProbe: (fn: () => void) => { onProbe = fn; }, noPty: () => { interactive = false; } };
}
function response() {
  const out = new EventEmitter() as EventEmitter & { writableLength: number; frames: string[]; destroyed: boolean; writeHead: () => void; flushHeaders: () => void; write: (text: string) => void; destroy: () => void };
  Object.assign(out, { writableLength: 0, frames: [], destroyed: false, writeHead() {}, flushHeaders() {}, write(text: string) { out.frames.push(text); }, destroy() { out.destroyed = true; out.emit("close"); } });
  return out;
}

test("terminal grants default off, require a contributor and a canonical mapped repository", async () => {
  const f = await fixture(); await assert.rejects(f.open(), status(403)); await f.configure([f.bob.userId]); await assert.rejects(f.open(), status(403));
  await f.configure(); f.users[0]!.roles["p-1"] = "reviewer"; await assert.rejects(f.open(), status(403)); await assert.rejects(f.configure(), status(400));
  f.users[0]!.roles["p-1"] = "contributor"; await assert.rejects(f.open(owner), status(403));
  await assert.rejects(f.open({ ...f.alice, via: "runner" }), status(403));
  f.options.resolveRepo = () => "/unmapped"; await assert.rejects(f.open(), status(409)); assert.equal(f.starts(), 0);
});

test("sessions are private in the API; owner can close but cannot attach or type", async () => {
  const f = await fixture(); await f.configure(); const a = await f.open(), b = await f.open(f.bob);
  assert.deepEqual(f.service.view(f.alice).sessions.map((s) => s.id), [a.id]); assert.deepEqual(f.service.view(f.bob).sessions.map((s) => s.id), [b.id]);
  assert.equal(f.service.view(owner).sessions.length, 2); assert.deepEqual(f.service.view(f.alice).audit, []);
  for (const actor of [f.bob, owner]) {
    assert.throws(() => f.service.input(actor, a.id, { data: "whoami\r" }), status(404));
    assert.throws(() => f.service.resize(actor, a.id, { cols: 80, rows: 24 }), status(404));
    assert.throws(() => f.service.watch(actor, a.id, response() as unknown as ServerResponse, () => {}), status(404));
  }
  await assert.rejects(f.service.closeSession(f.bob, a.id), status(404)); await f.service.closeSession(owner, a.id); assert.ok(f.closed.includes(a.id)); assert.equal(f.service.active(), 1);
});

test("live changes reject input immediately and terminate the shell and its stream", async () => {
  for (const change of ["grant", "role", "revision", "disabled", "mapping", "global"] as const) {
    const f = await fixture(); await f.configure(); const s = await f.open(), res = response();
    f.service.watch(f.alice, s.id, res as unknown as ServerResponse, () => {}); assert.match(res.frames.join(""), /private output/);
    if (change === "grant") await f.configure([]);
    if (change === "role") f.users[0]!.roles["p-1"] = "reviewer";
    if (change === "revision") f.users[0]!.revision++;
    if (change === "disabled") f.users[0]!.enabled = false;
    if (change === "mapping") f.options.resolveRepo = () => undefined;
    if (change === "global") f.options.enabled = () => false;
    assert.throws(() => f.service.input(f.alice, s.id, { data: "pwd\r" }), status(404));
    await f.service.reap(); assert.equal(f.service.active(), 0); assert.equal(res.destroyed, true); assert.ok(f.closed.includes(s.id));
  }
});

test("authorization is rechecked after PTY discovery and spawn", async () => {
  const before = await fixture(); await before.configure(); before.onProbe(() => { before.users[0]!.enabled = false; }); await assert.rejects(before.open(), status(403)); assert.equal(before.starts(), 0);
  const during = await fixture(); await during.configure(); during.onOpen(() => { during.users[0]!.revision++; }); await assert.rejects(during.open(), status(403)); assert.equal(during.starts(), 1); assert.equal(during.running.size, 0);
  const expired = await fixture(); await expired.configure(); let valid = true; expired.onOpen(() => { valid = false; });
  await assert.rejects(expired.open(expired.alice, () => { if (!valid) throw new CollabError("Session expired", 401); }), status(401)); assert.equal(expired.running.size, 0);
  const noPty = await fixture(); await noPty.configure(); noPty.noPty(); await assert.rejects(noPty.open(), status(409)); assert.equal(noPty.starts(), 0);
});

test("limits are serialized; input validates sizes, binary encoding and backpressure", async () => {
  const f = await fixture(); await f.configure(); const attempts = await Promise.allSettled([f.open(), f.open(), f.open()]); assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 2); assert.equal(f.starts(), 2);
  const s = f.service.view(f.alice).sessions[0]!;
  for (const body of [{}, { data: "a", binary: "b" }, { data: "a".repeat(32769) }, { binary: "🙂" }, { data: "a", cwd: "/" }]) assert.throws(() => f.service.input(f.alice, s.id, body), status(400));
  f.backlog(131073); assert.throws(() => f.service.input(f.alice, s.id, { data: "x" }), status(429)); f.backlog(0);
  f.service.input(f.alice, s.id, { data: "hello🙂\u0003" }); f.service.input(f.alice, s.id, { binary: "\xff" }); assert.equal(f.inputs.length, 2);
  assert.throws(() => f.service.resize(f.alice, s.id, { cols: 501, rows: 24 }), status(400)); f.service.resize(f.alice, s.id, { cols: 120, rows: 40 }); assert.equal(f.running.get(s.id)?.cols, 120);
});

test("output and resizing do not extend the keyboard idle deadline", async () => {
  const f = await fixture(); await f.configure(); const s = await f.open();
  f.advance(TERMINAL_IDLE_MS - 1); f.service.resize(f.alice, s.id, { cols: 100, rows: 40 }); await f.service.reap(); assert.equal(f.service.active(), 1);
  f.service.input(f.alice, s.id, { data: "\r" }); f.advance(TERMINAL_IDLE_MS - 1); await f.service.reap(); assert.equal(f.service.active(), 1);
  f.advance(1); await f.service.reap(); assert.equal(f.service.active(), 0); assert.match(f.service.view(owner).audit.at(-1)!.reason!, /30 minutes/);
});

test("streams check session validity on each frame, bound viewers and disconnect slow consumers", async () => {
  const f = await fixture(); await f.configure(); const s = await f.open(); let valid = true; const a = response(), b = response();
  f.service.watch(f.alice, s.id, a as unknown as ServerResponse, () => { if (!valid) throw new Error("Expired"); });
  f.service.watch(f.alice, s.id, b as unknown as ServerResponse, () => {});
  assert.throws(() => f.service.watch(f.alice, s.id, response() as unknown as ServerResponse, () => {}), status(429));
  b.writableLength = 600_000; f.callbacks.get(s.id)!({ type: "output", text: "more" }); assert.equal(b.destroyed, true);
  a.destroy(); const c = response(); f.service.watch(f.alice, s.id, c as unknown as ServerResponse, () => { if (!valid) throw new Error("Expired"); });
  valid = false; f.callbacks.get(s.id)!({ type: "output", text: "secret after expiry" }); assert.equal(c.destroyed, true); assert.ok(!c.frames.join("").includes("secret after expiry"));
});

test("restart never restores sessions; durable audit contains no command or output", async () => {
  const f = await fixture(); await f.configure(); const s = await f.open(); f.service.input(f.alice, s.id, { data: "private-command\r" });
  const saved = readFileSync(f.file, "utf8"); assert.ok(!saved.includes("private-command")); assert.ok(!saved.includes("private output")); assert.equal(statSync(f.file).mode & 0o777, 0o600);
  await f.service.close(); writeFileSync(f.file, saved); // Simulate the last durable state before a crash.
  const restored = new TeamTerminals(f.options); services.push(restored); await restored.load(); assert.equal(restored.active(), 0); assert.equal(f.starts(), 1); assert.match(restored.view(owner).audit.at(-1)!.reason!, /restarted/);
});

test("audit storage failure closes a spawned shell and disables terminal access", async () => {
  const f = await fixture(); await f.configure();
  f.onOpen(() => { const dir = dirname(f.file); rmSync(dir, { recursive: true }); writeFileSync(dir, "unavailable storage"); });
  await assert.rejects(f.open()); assert.equal(f.running.size, 0); assert.equal(f.service.active(), 0); assert.throws(() => f.service.view(owner), status(503));
});

test("HTTP routes reject escalation, arbitrary directories, extra paths and foreign origins", async () => {
  const f = await fixture(); await f.configure();
  const server = createServer((req, res) => { void handleTeamTerminals(req, res, (req.url ?? "").split("/").filter(Boolean), f.service, () => f.alice, () => { if (req.headers.origin !== "http://test") throw new CollabError("Origin required", 403); }).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/team-terminals`;
  try {
    const request = (path: string, body: unknown = {}, method = "POST", origin = "http://test") => fetch(base + path, { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await request("/settings", {}, "PUT")).status, 403);
    assert.equal((await request("", { projectId: "p-1", repository: "app", cols: 80, rows: 24, cwd: "/" })).status, 400);
    assert.equal((await request("/extra/segments/more")).status, 404);
    assert.equal((await request("", {}, "POST", "http://other")).status, 403);
    const created = await request("", { projectId: "p-1", repository: "app", cols: 80, rows: 24 }); assert.equal(created.status, 201); const s = await created.json() as { id: string };
    assert.equal((await request(`/${s.id}/input`, { data: "pwd\r" })).status, 200); assert.equal((await request(`/${s.id}`, {}, "DELETE")).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
