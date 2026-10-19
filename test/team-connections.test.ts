import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamConnections } from "../src/collab/connections.js";
import { CollabStore } from "../src/collab/store.js";
import type { RunnerManager } from "../src/collab/runner.js";

const manager = { get: () => undefined, list: () => [] } as unknown as RunnerManager;
const user = { userId: "u-alice", username: "alice", displayName: "Alice" };
const document = (url: string) => ({ version: 1, url, runnerId: "r-" + "a".repeat(16), token: "tr-" + "a".repeat(43), user, machineName: "Laptop", mappings: { "p-same": { app: "/repo/old-team" } } });
async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(join(tmpdir(), "codeflow-connections-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests: { url: string; authorization: string | null; method: string }[] = [];
  let issued = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), method });
    if (url.endsWith("/runners/connect")) {
      issued++;
      return Response.json({ runner: { id: `r-${issued.toString(16).padStart(16, "0")}` }, token: `tr-${String(issued).repeat(43)}`, user, hub: { name: new URL(url).hostname } });
    }
    if (url.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already cancelled by the reader */ } }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ origin: new URL(url).origin });
  };
  const options = { home, manager, findPattern: () => undefined, retryIntervalMs: 0, store: new CollabStore({ dir: join(home, "team"), members: () => [], projects: () => [] }), linkOptions: { fetch: fetchImpl } };
  const connections = new TeamConnections(options); t.after(() => connections.close());
  return { home, requests, options, connections };
}

test("saved connections isolate credentials, mappings and requests and survive a restart", async (t) => {
  const { home, requests, options, connections } = await fixture(t); await connections.load();
  const a = await connections.connect({ url: "https://team-a.example", username: "alice", password: "secret" });
  const b = await connections.connect({ url: "https://team-b.example", username: "alice", password: "secret" });
  assert.notEqual(a.id, b.id); assert.equal(connections.inventory().length, 3);
  await a.link.json("/api/team/board"); await b.link.json("/api/team/board");
  const boards = requests.filter((request) => request.url.endsWith("/board"));
  assert.equal(boards[0]!.authorization, `Bearer tr-${"1".repeat(43)}`); assert.equal(boards[1]!.authorization, `Bearer tr-${"2".repeat(43)}`);
  assert.doesNotMatch(JSON.stringify(connections.inventory()), /tr-|secret/);
  assert.throws(() => connections.get(), /Choose a team/); assert.throws(() => connections.get("missing"), /unavailable/);
  await assert.rejects(connections.connect({ url: "https://team-a.example/", username: "alice", password: "secret" }), /already saved/);
  assert.equal(requests.filter((request) => request.url.endsWith("/connect")).length, 2, "duplicate enrolment never contacts the hub");
  const file = join(home, "team-connections", `${a.id}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Two hubs use the exact same project and repository identifiers.
  const da = JSON.parse(await readFile(file, "utf8")); da.mappings = { "p-same": { app: "/repo/a" } }; await writeFile(file, JSON.stringify(da));
  const otherFile = join(home, "team-connections", `${b.id}.json`), db = JSON.parse(await readFile(otherFile, "utf8")); db.mappings = { "p-same": { app: "/repo/b" } }; await writeFile(otherFile, JSON.stringify(db));
  await connections.close();
  const restarted = new TeamConnections(options); t.after(() => restarted.close()); await restarted.load();
  assert.equal(restarted.get(a.id).link.runnerId, a.link.runnerId);
  assert.equal(restarted.get(a.id).link.resolveRepo("p-same", "app"), "/repo/a"); assert.equal(restarted.get(b.id).link.resolveRepo("p-same", "app"), "/repo/b");
  await restarted.disconnect(a.id); assert.equal(restarted.get(b.id).link.linked, true);
  assert.throws(() => restarted.get(a.id), /unavailable/);
  assert.deepEqual(requests.filter((request) => request.method === "DELETE").map((request) => new URL(request.url).origin), ["https://team-a.example"]);
});

test("legacy credentials migrate atomically and old local and remote journals are isolated", async (t) => {
  const { home, options, connections } = await fixture(t);
  await writeFile(join(home, "team-link.json"), JSON.stringify(document("https://old-team.example")), { mode: 0o600 });
  const attempts = join(home, "team-link", "attempts"); await mkdir(attempts, { recursive: true });
  const record = { taskId: "t-" + "a".repeat(16), repo: "/repo", base: "a".repeat(40), state: "finished", lastSeq: 1, lastAckedSeq: 1, deliveredInstructionIds: [], updatedAt: 1 };
  await writeFile(join(attempts, `${"1".repeat(32)}.json`), JSON.stringify({ ...record, attemptId: "1".repeat(32), hubUrl: "https://old-team.example" }));
  await writeFile(join(attempts, `${"2".repeat(32)}.json`), JSON.stringify({ ...record, attemptId: "2".repeat(32) }));
  await connections.load();
  const remote = connections.get("legacy"), local = connections.get("local");
  assert.equal(remote.link.resolveRepo("p-same", "app"), "/repo/old-team"); assert.deepEqual(local.link.state().mappings, {});
  assert.deepEqual((await remote.runner.attempts()).map((record) => record.attemptId), ["1".repeat(32)]);
  assert.deepEqual((await local.runner.attempts()).map((record) => record.attemptId), ["2".repeat(32)]);
  assert.equal((await stat(join(home, "team-connections", "legacy.json"))).mode & 0o777, 0o600);
  await assert.rejects(stat(join(home, "team-link.json")), { code: "ENOENT" });
  await connections.close(); const restarted = new TeamConnections(options); t.after(() => restarted.close()); await restarted.load();
  assert.equal(restarted.get("legacy").link.runnerId, remote.link.runnerId);
});

test("disconnect cannot race a task operation or abandon unsettled work", async (t) => {
  const { home, connections } = await fixture(t); await connections.load();
  const remote = await connections.connect({ url: "https://team.example", username: "alice", password: "secret" });
  let release!: () => void;
  const operation = connections.use(remote.id, () => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(connections.disconnect(remote.id), /operation is in progress/); release(); await operation;
  const dir = join(home, "team-runners", remote.id, "attempts"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${"3".repeat(32)}.json`), JSON.stringify({ attemptId: "3".repeat(32), taskId: "t-" + "b".repeat(16), hubUrl: remote.link.url, repo: "/repo", base: "a".repeat(40), state: "unknown", lastSeq: 0, lastAckedSeq: 0, deliveredInstructionIds: [], updatedAt: 1 }));
  await remote.runner.reconcile();
  await assert.rejects(connections.disconnect(remote.id), /active attempts/);
  assert.equal(remote.link.linked, true);
});
