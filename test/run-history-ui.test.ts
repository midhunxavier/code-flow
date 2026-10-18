import test from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../ui/types.js";

Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
const state = await import("../ui/state.js");
const requests: Array<{ url: URL; respond: (body: unknown) => void; done: boolean }> = [];
globalThis.fetch = ((input: string) => new Promise<Response>((resolve) => { const item = { url: new URL(input, "http://localhost"), done: false, respond: (body: unknown) => { item.done = true; resolve(new Response(JSON.stringify(body), { status: 200 })); } }; requests.push(item); })) as typeof fetch;
const run = (id: string, task = id, status = "done") => ({ id, task, status, createdAt: 100, roles: {}, repo: "/repo", pattern: "pipeline", branchPrefix: id } as RunSummary);
const respond = async (query: string, body: unknown, cursor?: string) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const item = requests.find((entry) => !entry.done && entry.url.pathname === "/api/runs" && (entry.url.searchParams.get("q") ?? "") === query && (entry.url.searchParams.get("cursor") ?? "") === (cursor ?? ""));
    if (item) { item.respond(body); await new Promise<void>((resolve) => setImmediate(resolve)); return; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`No pending page for ${query}, cursor=${cursor}`);
};
class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  send(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
}
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });

test("paged history preserves loaded older runs and cursor progress on refresh and live snapshots", async () => {
  const first = state.refreshRuns();
  await respond("", { runs: [run("new")], total: 250, nextCursor: "cursor-a" }); await first;
  const more = state.loadOlderRuns();
  await respond("", { runs: [run("older")], total: 250, nextCursor: "cursor-b" }, "cursor-a"); await more;
  const refresh = state.refreshRuns();
  await respond("", { runs: [run("new", "updated")], total: 251, nextCursor: "new-boundary" }); await refresh;
  assert.equal(state.runs.value.has("older"), true);
  assert.equal(state.historyNextCursor.value, "cursor-b", "a first-page refresh must not restart older pagination");
  state.watchAllRuns(() => undefined);
  const source = FakeEventSource.instances.at(-1)!;
  assert.equal(source.url, "/api/events?limit=100");
  source.send({ type: "hello", epoch: "server-one", seq: 10, total: 251, nextCursor: "new-boundary", runs: [run("new", "latest") ] });
  assert.equal(state.runs.value.has("older"), true);
  assert.equal(state.historyNextCursor.value, "cursor-b");
  const racing = state.refreshRuns();
  source.send({ type: "run", seq: 11, run: run("new", "live update", "running") });
  await respond("", { runs: [run("new", "stale API snapshot")], total: 251, nextCursor: "new-boundary" }); await racing;
  assert.equal(state.runs.value.get("new")?.task, "live update", "late pages must not overwrite a newer streamed run");
});

test("search pages are queried remotely and stale query responses cannot replace cursor metadata", async () => {
  state.setRunFilter({ q: "alpha" });
  const alpha = state.refreshRuns();
  state.setRunFilter({ q: "beta" });
  const beta = state.refreshRuns();
  await respond("beta", { runs: [run("beta-run", "beta task")], total: 2, nextCursor: "beta-next" }); await beta;
  await respond("alpha", { runs: [run("alpha-run", "alpha task")], total: 80, nextCursor: "alpha-next" }); await alpha;
  assert.equal(state.historyTotal.value, 2);
  assert.equal(state.historyNextCursor.value, "beta-next");
  assert.equal(state.runs.value.has("alpha-run"), false);
  const more = state.loadOlderRuns();
  await respond("beta", { runs: [run("beta-old", "beta old task")], total: 2 }, "beta-next"); await more;
  assert.equal(state.historyNextCursor.value, null);
  assert.equal(state.runs.value.has("beta-old"), true);
});

test("a server restart drops stale cached history and refreshes an active search using the new sequence", async () => {
  const source = FakeEventSource.instances.at(-1)!;
  source.send({ type: "hello", epoch: "server-two", seq: 2, total: 1, runs: [run("beta-run", "new server snapshot")] });
  assert.equal(state.runs.value.has("older"), false);
  source.send({ type: "run", seq: 3, run: run("beta-run", "beta live new", "running") });
  await respond("beta", { runs: [run("beta-run", "older startup response")], total: 1 });
  assert.equal(state.runs.value.get("beta-run")?.task, "beta live new");
  assert.equal(state.historyTotal.value, 1);
});
