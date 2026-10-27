import test from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../ui/types.js";
const saved = new Map<string, string>([["railCollapsed", "1"]]), listeners = new Map<string, () => void>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
const state = await import("../ui/state.js");
let response: unknown = { runs: [], total: 0 };
globalThis.fetch = (async () => new Response(JSON.stringify(response))) as typeof fetch;
class FakeEventSource {
  static CLOSED = 2; static instances: FakeEventSource[] = []; readyState = 1;
  onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); } close() {}
  send(body: unknown) { this.onmessage?.({ data: JSON.stringify({ s: 1, d: body }) }); }
}
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
const r = (id: string, extra: Record<string, unknown> = {}) => ({ id, task: id, status: "running", createdAt: 1, roles: {}, repo: "/repo", pattern: "solo", ...extra } as RunSummary);
const awaiting = { kind: "plan", title: "Approve", content: "Plan", at: 1 };

test("first-seen hello, history and chat-family snapshots are silent, live transitions still notify", async () => {
  const notices: string[] = []; const stop = state.watchAllRuns(run => notices.push(run.id)); await new Promise<void>(resolve => queueMicrotask(resolve)); const source = FakeEventSource.instances.at(-1)!;
  source.send({ type: "hello", epoch: "qa", seq: 1, total: 3, runs: [r("old-approval", { awaiting }), r("old-team", { team: { awaitingRequestId: "q1", status: "running" } }), r("old-watch", { watches: { main: { state: "needs-you" } } })] });
  assert.deepEqual(notices, []);
  response = { runs: [r("old-history", { awaiting })], total: 1 }; await state.refreshRuns();
  response = [r("old-family", { awaiting })]; await state.loadAgentChats("old-family"); assert.deepEqual(notices, []);
  source.send({ type: "run", seq: 2, run: r("new-approval", { awaiting }) });
  source.send({ type: "run", seq: 3, run: r("old-approval", { awaiting }) });
  source.send({ type: "run", seq: 4, run: r("old-team", { team: { awaitingRequestId: "q2", status: "running" } }) });
  source.send({ type: "run", seq: 5, run: r("finishing") });
  source.send({ type: "run", seq: 6, run: r("finishing", { status: "done" }) });
  assert.deepEqual(notices, ["new-approval", "old-team", "finishing"]); stop();
});

test("provider and side chats count once per attention task while ordinary continuations stay separate", () => {
  const root = r("root", { status: "done" }), tab = r("tab", { status: "done", chatLink: { kind: "tab", workspaceId: "root", sourceId: "root" } }), side = r("side", { status: "done", chatLink: { kind: "side", workspaceId: "root", sourceId: "root" } });
  state.runs.value = new Map([root, tab, side, r("other", { status: "failed" })].map(run => [run.id, run])); assert.equal(state.waitingCount.value, 2);
});


test("complete task counts remain authoritative when only a small history page is loaded", () => {
  state.projectCounts.value = { "": { live: 250, archived: 0, waiting: 206, archivedTasks: 0, attentionTasks: 205, inboxRuns: 101, repositories: {} } };
  assert.equal(state.waitingCount.value, 205); state.projectCounts.value = null; assert.equal(state.waitingCount.value, 2);
});

test("temporary search expansion and phone layout preserve the explicit desktop collapse choice", () => {
  assert.equal(state.railIsCollapsed.value, true); state.peekRail(); assert.equal(state.railIsCollapsed.value, false); assert.equal(saved.get("railCollapsed"), "1");
  state.railPeek.value = false; assert.equal(state.railIsCollapsed.value, true);
  window.innerWidth = 390; listeners.get("resize")!(); assert.equal(state.railIsCollapsed.value, false); state.peekRail(); assert.equal(state.railPeek.value, false); assert.equal(saved.get("railCollapsed"), "1");
  window.innerWidth = 1440; listeners.get("resize")!(); assert.equal(state.railIsCollapsed.value, true);
  state.setRailCollapsed(false); assert.equal(saved.get("railCollapsed"), "0");
});
