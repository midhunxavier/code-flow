import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../ui/types.js";
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "127.0.0.1", hash: "", origin: "http://127.0.0.1" } });
const stored = new Map([["runFilter", JSON.stringify({ thisRepo: true })], ["repo", "/first"]]);
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
const state = await import("../ui/state.js");
const requests: { url: URL; done: boolean; respond: (body: unknown, status?: number) => void }[] = [];
globalThis.fetch = ((input: string) => new Promise<Response>(resolve => { const request = { url: new URL(input, "http://127.0.0.1"), done: false, respond: (body: unknown, status = 200) => { request.done = true; resolve(new Response(JSON.stringify(body), { status })); } }; requests.push(request); })) as typeof fetch;
const pending = (path = "/api/runs", cursor = "") => { const request = requests.find(item => !item.done && item.url.pathname === path && (item.url.searchParams.get("cursor") ?? "") === cursor); assert.ok(request, `pending ${path} ${cursor}`); return request; };
const run = (id: string, task = id) => ({ id, task, status: "done", createdAt: 100, repo: "/first", pattern: "pipeline", roles: {}, branchPrefix: id }) as RunSummary;
class FakeEventSource {
  static CLOSED = 2; static instances: FakeEventSource[] = []; readyState = 1;
  onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() {} send(body: unknown) { this.onmessage?.({ data: JSON.stringify({ s: 1, d: body }) }); }
}
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });

test("a saved repository filter survives the first stream hello and remains independent of the composer", async () => {
  assert.equal(state.runFilter.value.repo, "/first");
  const request = state.refreshRuns();
  const stop = state.watchAllRuns(() => {}); await new Promise<void>(resolve => queueMicrotask(resolve));
  FakeEventSource.instances.at(-1)!.send({ type: "hello", epoch: "first", seq: 5, total: 130, runs: [run("new", "stream is newer")] });
  pending().respond({ runs: [run("new", "old HTTP snapshot")], total: 12, nextCursor: "cursor-a" }); await request;
  assert.equal(state.historyTotal.value, 12); assert.equal(state.historyLoading.value, false);
  assert.equal(state.runs.value.get("new")?.task, "stream is newer");
  state.repoInfo.value = { repo: "/second", current: "main", branches: [], worktreeRoot: "/trees" };
  assert.equal(new URLSearchParams(state.historyRequestQuery()).get("repo"), "/first");
  assert.equal(state.matchesFilter({ ...run("other"), repo: "/second" }), false);
  stop();
});

test("Retry history repeats the failed cursor and leaves earlier pages intact", async () => {
  const older = state.loadOlderRuns(); pending("/api/runs", "cursor-a").respond({ error: "fixture older failure" }, 500); await older;
  assert.match(state.historyError.value, /older failure/);
  const poll = state.refreshRuns(); pending().respond({ runs: [run("new")], total: 13, nextCursor: "newer-boundary" }); await poll;
  assert.match(state.historyError.value, /older failure/, "a background first-page refresh cannot erase the failed older page");
  assert.equal(state.historyNextCursor.value, "cursor-a");
  const retry = state.retryHistory(); const request = pending("/api/runs", "cursor-a");
  assert.equal(request.url.searchParams.get("repo"), "/first");
  request.respond({ runs: [run("older")], total: 12 }); await retry;
  assert.equal(state.historyError.value, ""); assert.equal(state.historyNextCursor.value, null);
  assert.ok(state.runs.value.has("new")); assert.ok(state.runs.value.has("older"));
});

test("loading an older non-solo family supplies navigation without changing history totals", async () => {
  const before = state.historyTotal.value, cursor = state.historyNextCursor.value;
  const load = state.loadAgentChats("ancient"); pending("/api/runs/ancient/chats").respond([run("ancient")]); await load;
  assert.ok(state.runs.value.has("ancient")); assert.equal(state.historyTotal.value, before); assert.equal(state.historyNextCursor.value, cursor);
});
