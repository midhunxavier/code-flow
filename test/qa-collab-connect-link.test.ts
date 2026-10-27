import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubIdentity } from "../src/collab/hub-identity.js";
import { DEFAULT_LOCAL_CODEFLOW, computerSetupLink, savedConnectionFor, teamConnectionLink } from "../ui/team-join-link.js";
import { rememberSetupMappings, wizardProject } from "../ui/team-setup-state.js";
import type { RunnerManager } from "../src/collab/runner.js";
import type { Board } from "../src/collab/model.js";

const { TeamConnections } = await import("../src/collab/connections.js");
const { CollabStore } = await import("../src/collab/store.js");
const user = { userId: "u-alice", username: "alice", displayName: "Alice" };
async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(join(tmpdir(), "codeflow-connect-qa-"));
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const path = String(url); requests.push(path);
    if (path.endsWith("/runners/connect")) return Response.json({ runner: { id: "r-" + "a".repeat(16) }, token: "tr-" + "a".repeat(43), user, hub: { name: "QA" } });
    if (path.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* Reader already cancelled. */ } }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({});
  };
  const connections = new TeamConnections({ home, manager: { get: () => undefined, list: () => [] } as unknown as RunnerManager, findPattern: () => undefined, retryIntervalMs: 0, store: new CollabStore({ dir: join(home, "team"), members: () => [], projects: () => [] }), linkOptions: { fetch: fetcher } });
  t.after(async () => { await connections.close(); await rm(home, { recursive: true, force: true }); });
  return { home, connections, requests };
}
const input = (url: string) => ({ url, username: "alice", password: "fixture-password" });

test("loopback aliases never enroll a second runner, while another port is a separate server", async t => {
  const { connections, requests } = await fixture(t); await connections.load();
  await connections.connect(input("http://127.0.0.1:45671"));
  for (const host of ["localhost", "LOCALHOST", "[::1]"]) await assert.rejects(connections.connect(input(`http://${host}:45671`)), /already saved/);
  assert.equal(requests.filter(path => path.endsWith("/runners/connect")).length, 1);
  await connections.connect(input("http://localhost:45673")); assert.equal(connections.inventory().length, 3);
  assert.equal(connections.inventory().at(-1)?.url, "http://localhost:45673", "stored/request URL stays unchanged");
  assert.equal(hubIdentity("https://LOCALHOST:443/"), "https://127.0.0.1");
});

test("concurrent alias requests share the same serialized duplicate check", async t => {
  const { connections, requests } = await fixture(t); await connections.load();
  const results = await Promise.allSettled([connections.connect(input("http://localhost:45671")), connections.connect(input("http://127.0.0.1:45671"))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(requests.filter(path => path.endsWith("/runners/connect")).length, 1);
});

test("conflicting legacy records degrade connection access without modifying either credential file", async t => {
  const { home, connections, requests } = await fixture(t);
  const original = join(home, "team-link.json"), migrated = join(home, "team-connections/legacy.json");
  const record = { version: 1, url: "http://127.0.0.1:9", runnerId: "r-" + "a".repeat(16), token: "tr-" + "a".repeat(43), user, machineName: "fixture", mappings: {} };
  await mkdir(join(home, "team-connections"));
  const one = JSON.stringify(record), two = JSON.stringify({ ...record, runnerId: "r-" + "b".repeat(16) });
  await writeFile(original, one, { mode: 0o600 }); await writeFile(migrated, two, { mode: 0o600 });
  await connections.load(); connections.start();
  for (const operation of [() => connections.inventory(), () => connections.get(), () => connections.get("local"), () => connections.get("legacy")]) assert.throws(operation, (error: any) => error.status === 503 && error.message.includes(original) && error.message.includes(migrated));
  await assert.rejects(connections.connect(input("http://localhost:45671")), /Neither file was changed/);
  assert.equal(await readFile(original, "utf8"), one); assert.equal(await readFile(migrated, "utf8"), two); assert.deepEqual(requests, []);
});

test("computer handoff defaults to the installed port and selects only the intended saved account", () => {
  assert.equal(DEFAULT_LOCAL_CODEFLOW, "http://localhost:4317");
  const hint = teamConnectionLink("https://hub.example", "alice", "p-shared");
  const link = computerSetupLink(DEFAULT_LOCAL_CODEFLOW, hint);
  assert.match(link, /^http:\/\/localhost:4317\/team-handoff#/); assert.doesNotMatch(link, /token|password/);
  const saved = [{ id: "local", linked: false }, { id: "bob", linked: true, url: "https://hub.example", user: { username: "bob" } }, { id: "alice", linked: true, url: "https://hub.example", user: { username: "alice" } }];
  assert.equal(savedConnectionFor(saved, hint), "alice"); assert.equal(savedConnectionFor(saved, teamConnectionLink("https://elsewhere.example", "alice")), undefined);
  assert.equal(savedConnectionFor([{ id: "alias", linked: true, url: "http://127.0.0.1:45671", user }], teamConnectionLink("http://localhost:45671", "alice")), "alias");
  assert.equal(savedConnectionFor(saved, "https://hub.example/#/join/" + "a".repeat(43)), undefined);
});

test("wizard project resume ignores deleted projects and falls back to a configured board project", () => {
  const projects = [{ id: "first" }, { id: "shared" }, { id: "new" }], board = { projects: [{ id: "shared", repositories: [{ key: "app" }] }] } as Pick<Board, "projects">;
  assert.equal(wizardProject(projects, board, "new", "first"), "new");
  assert.equal(wizardProject(projects, board, "deleted", "first"), "shared");
  assert.equal(wizardProject(projects, { projects: [] }, null, "new"), "new");
  assert.equal(wizardProject([], board, "new"), "");
});

test("setup remembers target-host folders, preserves explicit mappings and reports partial failures", async () => {
  const requests: { path: string; body?: object; method?: string }[] = [];
  const request = async <T,>(path: string, body?: object, method?: string): Promise<T> => {
    requests.push({ path, body, method });
    if (!body) return { mappings: { project: { existing: "/explicit/path" } } } as T;
    if ((body as any).repository === "bad") throw new Error("not a repository");
    return {} as T;
  };
  assert.deepEqual(await rememberSetupMappings(request, "project", [{ key: "existing", sourcePath: "/detected/path" }, { key: " app ", sourcePath: "/repo" }, { key: "bad", sourcePath: "/missing" }, { key: "remote" }]), ["bad: not a repository"]);
  assert.equal(requests.length, 3); assert.ok(requests.every(request => request.path.includes("teamConnection=local")));
  assert.deepEqual(requests[1]?.body, { projectId: "project", repository: "app", path: "/repo" });
});
