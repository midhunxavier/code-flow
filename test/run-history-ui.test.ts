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
  close() {}
  send(body: unknown) { this.onmessage?.({ data: JSON.stringify({ s: 1, d: body }) }); }
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
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const source = FakeEventSource.instances.at(-1)!;
  const url = new URL(source.url, "http://localhost");
  assert.equal(url.pathname, "/api/stream");
  assert.deepEqual(JSON.parse(url.searchParams.get("subs")!), [{ id: 1, topic: "runs" }]);
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

test("status, provider and repository filters have independent server cursors and discard late responses", async () => {
  state.runFilter.value = { q: "", status: "passed", pattern: "solo", agent: "claude", repo: "/first" };
  state.repoInfo.value = { repo: "/first", worktreeRoot: "/trees", current: "main", branches: [] };
  const old = state.refreshRuns();
  const oldRequest = requests.find(entry => !entry.done && entry.url.searchParams.get("repo") === "/first")!;
  assert.equal(oldRequest.url.searchParams.get("status"), "passed");
  assert.equal(oldRequest.url.searchParams.get("pattern"), "solo");
  assert.equal(oldRequest.url.searchParams.get("agent"), "claude");
  state.repoInfo.value = { ...state.repoInfo.value, repo: "/second" };
  state.runFilter.value = { ...state.runFilter.value, repo: "/second" };
  const fresh = state.refreshRuns();
  const freshRequest = requests.find(entry => !entry.done && entry.url.searchParams.get("repo") === "/second")!;
  freshRequest.respond({ runs: [], total: 0 }); await fresh;
  oldRequest.respond({ runs: [run("wrong-repo")], total: 100, nextCursor: "wrong-cursor" }); await old;
  assert.equal(state.historyTotal.value, 0);
  assert.equal(state.historyNextCursor.value, null);
  assert.equal(state.runs.value.has("wrong-repo"), false);
  const source = FakeEventSource.instances.at(-1)!;
  source.send({ type: "hello", epoch: "server-two", seq: 4, total: 999, nextCursor: "unfiltered", runs: [] });
  assert.equal(state.historyTotal.value, 0, "an unfiltered stream snapshot cannot overwrite filtered totals");
  assert.equal(state.historyNextCursor.value, null);
});


test("provider tabs share task-scoped side chats and migrate previous per-tab memories", () => {
  const root = { ...run("task"), pattern: "solo" };
  const fork = { ...run("fork"), pattern: "solo", chatLink: { workspaceId: "task", sourceId: "task", kind: "tab" as const } };
  const side = { ...run("side"), pattern: "solo", chatLink: { workspaceId: "task", sourceId: "fork", kind: "side" as const } };
  const other = { ...run("other"), pattern: "solo" };
  state.runs.value = new Map([root, fork, side, other].map(item => [item.id, item]));
  state.sideMemory.value = {
    "run:task": { at: 10, chats: [], tab: "chat" },
    "run:fork": { at: 20, chat: "side", chats: ["side"], tab: "chat" },
  };
  state.route.value = { view: "run", id: "task" };
  assert.equal(state.sideScope.value.key, "run:task");
  assert.equal(state.sideChat.value, "side", "the task recovers a side chat created from an older fork");
  state.route.value = { view: "run", id: "fork" };
  assert.equal(state.sideScope.value.key, "run:task");
  assert.equal(state.sideScope.value.run?.id, "fork", "new side requests inherit the selected conversation's context");
  assert.deepEqual(state.sideMemo.value.chats, ["side"]);
  state.rememberSide({ chats: [], closed: ["side"], chat: "" });
  assert.deepEqual(state.sideMemo.value.chats, [], "closed legacy chats do not reappear during migration");
  state.setSideChat("side");
  assert.deepEqual(state.sideMemo.value.chats, ["side"]);
  state.route.value = { view: "run", id: "other" };
  assert.equal(state.sideChat.value, null, "unrelated tasks keep their own side chats");
  state.setSideChat("side", "run:fork");
  assert.equal(state.sideChat.value, null, "a late send response does not move another task's panel");
  state.route.value = { view: "run", id: "task" };
  assert.equal(state.sideChat.value, "side");
  state.rememberAgentTab(fork);
  assert.equal(state.lastAgentTabs.value.task, "fork");
  state.rememberAgentTab(side);
  assert.equal(state.lastAgentTabs.value.task, "fork", "opening a side chat preserves the selected main tab");
});
