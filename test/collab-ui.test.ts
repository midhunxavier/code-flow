import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { Attempt, AttemptState } from "../src/collab/model.js";

// ui/navigation.ts is pure, but the ui modules expect a browser; the shims match test/run-history-ui.test.ts.
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
/** Every fetch waits until the test answers it, so the order of requests and answers is the test's. */
const requests: Array<{ url: URL; done: boolean; respond: (body: unknown, status?: number) => void }> = [];
globalThis.fetch = ((input: string) => new Promise<Response>((resolve) => { const item = { url: new URL(input, "http://localhost"), done: false, respond: (body: unknown, status = 200) => { item.done = true; resolve(new Response(JSON.stringify(body), { status })); } }; requests.push(item); })) as typeof fetch;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function answer(path: string, body: unknown) {
  for (let attempt = 0; attempt < 30; attempt++) { const item = requests.find((entry) => !entry.done && entry.url.pathname === path); if (item) { item.respond(body); await settle(); await settle(); return; } await settle(); }
  assert.fail(`No pending request for ${path}; seen: ${requests.map((entry) => `${entry.url.pathname}${entry.done ? "" : " (pending)"}`).join(", ")}`);
}
class FakeEventSource {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1; closed = false;
  onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  /** A frame as the server sends it (the owner stream wraps frames in `{ s, d }`; the test builds that envelope itself). */
  send(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
  fail() { this.readyState = 2; this.onerror?.(); }
}
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
const { hashFor, parseRouteHash } = await import("../ui/navigation.js");
const { SETTINGS_SECTIONS, searchSettings, settingsSection } = await import("../ui/settings-sections.js");
const { TEAM_EVENTS_RETRY_MS, applyTeamEvent, attemptResumable, inboxUnread, openTeamEvents, shownAttempt, teamServerAddress, teamTick, watchTeam } = await import("../ui/collab-state.js");
type Route = import("../ui/navigation.js").Route;

test("team routes parse from their hashes and serialize back to them", () => {
  assert.deepEqual(parseRouteHash("#/team"), { view: "team" });
  assert.deepEqual(parseRouteHash("#/team/"), { view: "team" });
  assert.deepEqual(parseRouteHash("#/team/project/p-1"), { view: "team", project: "p-1" });
  assert.deepEqual(parseRouteHash("#/team/task/t-0123456789abcdef"), { view: "team-task", id: "t-0123456789abcdef" });
  assert.deepEqual(parseRouteHash("#/team/task/t-0123456789abcdef/extra"), { view: "team-task", id: "t-0123456789abcdef" }, "trailing segments are ignored");
  assert.deepEqual(parseRouteHash("#/team/task"), { view: "team" }, "an incomplete task link lands on the board");
  assert.deepEqual(parseRouteHash("#/team/project"), { view: "team" });
  assert.deepEqual(parseRouteHash("#/team/other"), { view: "team" });
  assert.equal(hashFor({ view: "team" }), "#/team");
  assert.equal(hashFor({ view: "team", project: "p-1" }), "#/team/project/p-1");
  assert.equal(hashFor({ view: "team-task", id: "t-0123456789abcdef" }), "#/team/task/t-0123456789abcdef");
  const routes: Route[] = [{ view: "team" }, { view: "team", project: "p 1/x" }, { view: "team-task", id: "t-0123456789abcdef" }, { view: "team-task", id: "odd id/with slash" }];
  for (const route of routes) assert.deepEqual(parseRouteHash(hashFor(route)), route, `round trip of ${JSON.stringify(route)}`);
  assert.equal(hashFor({ view: "team", project: "p 1/x" }), "#/team/project/p%201%2Fx", "project ids are encoded like other ids");
  // Neighbouring routes are untouched.
  assert.deepEqual(parseRouteHash("#/project/p-1"), { view: "project", id: "p-1" });
  assert.deepEqual(parseRouteHash("#/settings/team"), { view: "settings", section: "connections", group: "manage" });
  assert.equal(hashFor({ view: "settings", section: "connections", group: "sharing" }), "#/settings/connections/sharing");
});

test("Settings has a Team section under Connections that search and the palette find", () => {
  assert.equal(settingsSection("connections"), "connections");
  assert.equal(settingsSection("teams"), "general", "unknown ids still fall back to General");
  const entry = SETTINGS_SECTIONS.find((item) => item.id === "connections");
  assert.ok(entry, "SETTINGS_SECTIONS lists team");
  assert.equal(entry.label, "Connections"); assert.equal(entry.group, "Connections"); assert.equal(entry.icon, "terminal");
  assert.equal(entry.description, "Work on another computer, delegate execution, or share access.");
  for (const word of ["handoff", "runner", "board", "teammates", "tailscale"]) assert.ok(searchSettings(word).some((item) => item.id === "connections"), `searching ${word} finds Team`);
  const ids = SETTINGS_SECTIONS.map((item) => item.id); assert.equal(new Set(ids).size, ids.length, "section ids stay unique");
});

test("the Team server card offers the listener's origin over HTTPS and never the phone link's secret path", () => {
  // GET /api/remote reports the phone link: /r/<read-only secret>, or the owner pairing link while phone control is on.
  assert.equal(teamServerAddress({ secure: true, tailscaleUrl: "https://hub.test.ts.net:4318/r/7689e987c0ffee3d51a1b2c3d4e5f60718293a4b5c6d7e8f9091a2b3c4d5e6f7" }), "https://hub.test.ts.net:4318");
  assert.equal(teamServerAddress({ secure: true, tailscaleUrl: "https://hub.test.ts.net:4318/r/4717595c0ffee2c" }), "https://hub.test.ts.net:4318", "with phone control on the path is the pairing link; the origin is the same");
  assert.equal(teamServerAddress({ secure: false, tailscaleUrl: "http://100.64.0.7:4318/r/7689e987" }), undefined, "without TLS runner credentials cannot travel, so no address is offered");
  assert.equal(teamServerAddress({ secure: true, tailscaleUrl: "http://hub.test.ts.net:4318/r/7689e987" }), undefined, "an http:// link is never handed out, whatever the flag says");
  assert.equal(teamServerAddress({ secure: true, tailscaleUrl: "not a url" }), undefined);
  assert.equal(teamServerAddress({ secure: true }), undefined); assert.equal(teamServerAddress(null), undefined); assert.equal(teamServerAddress(undefined), undefined);
});

const attempt = (id: string, state: AttemptState): Attempt => ({ id, taskId: "t-0123456789abcdef", runnerId: "local", runnerName: "laptop", user: { userId: "owner", displayName: "Owner" }, state, baseCommit: "a".repeat(40), createdAt: 1, lastSeq: 1, lastHeartbeatAt: 1, progress: { updatedAt: 1 } });
test("the Execution card shows the latest attempt once none is current, and offers Resume for the states the link API resumes", () => {
  assert.equal(shownAttempt({ attempts: [] }), undefined, "only a task without attempts says 'No attempt yet'");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "finished")] })?.id, "a1", "a finished attempt stays on the page with its summary and run link");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "finished"), attempt("a2", "stopped")] })?.id, "a2", "the latest ended attempt wins");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "paused"), attempt("a2", "superseded")] })?.id, "a1", "a current attempt (paused counts) wins over a later superseded one");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "failed"), attempt("a2", "running")] })?.id, "a2");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "running"), attempt("a2", "failed")] })?.id, "a1", "a busy attempt is always the one shown");
  // src/collab/link-api.ts resumes paused, stopped and unknown records under the same attempt id.
  for (const state of ["paused", "stopped", "unknown"] as const) assert.equal(attemptResumable(attempt("a", state)), true, `${state} resumes`);
  for (const state of ["claimed", "running", "finished", "failed", "superseded"] as const) assert.equal(attemptResumable(attempt("a", state)), false, `${state} does not resume`);
  assert.equal(attemptResumable(attempt("a", "paused"), { status: "working" }), true); assert.equal(attemptResumable(attempt("a", "stopped"), { status: "done" }), false, "nothing resumes on a Done task: the server refuses the revive, so the button is not offered");
});

test("team stream frames set the unread count, a hello without one fetches it, and every frame but a refusal reloads the pages", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const tick = teamTick.value; inboxUnread.value = 0;
    applyTeamEvent({ type: "inbox", seq: 4, unread: 5 } as never); assert.equal(inboxUnread.value, 5);
    mock.timers.tick(200); assert.equal(teamTick.value, tick + 1, "an inbox frame reloads the board too: marking items read moves the cards' Needs-you badges");
    applyTeamEvent({ type: "change", seq: 5, kind: "task" } as never); applyTeamEvent({ type: "change", seq: 6, kind: "task" } as never); mock.timers.tick(200);
    assert.equal(teamTick.value, tick + 2, "a burst of changes is one reload"); assert.equal(inboxUnread.value, 5, "a change frame leaves the count alone");
    applyTeamEvent({ type: "error", message: "declined" } as never); mock.timers.tick(200); assert.equal(teamTick.value, tick + 2, "a refused topic reloads nothing");
    applyTeamEvent({ type: "inbox", seq: 7, unread: -1 } as never); assert.equal(inboxUnread.value, 5, "a malformed count is ignored");
    // The shared dashboard's stream: the hub's hello carries the count.
    const before = FakeEventSource.instances.length, close = openTeamEvents();
    const source = FakeEventSource.instances[before]!; assert.equal(source.url, "/api/team/events"); assert.equal(FakeEventSource.instances.length, before + 1);
    source.send({ type: "hello", epoch: "e1", seq: 9, unread: 2 }); assert.equal(inboxUnread.value, 2);
    source.send({ type: "inbox", seq: 10, unread: 0 }); assert.equal(inboxUnread.value, 0);
    assert.equal(requests.some((entry) => entry.url.pathname === "/api/team/inbox" && !entry.done), false, "a hello with the count fetches nothing");
    // The browser gives up on an HTTP error (a session that ended, the per-account cap): the stream is reopened later, and a closed one never is.
    source.fail(); assert.equal(FakeEventSource.instances.length, before + 1); mock.timers.tick(TEAM_EVENTS_RETRY_MS);
    assert.equal(FakeEventSource.instances.length, before + 2, "a closed stream is reopened after the retry delay"); assert.equal(FakeEventSource.instances[before + 1]!.url, "/api/team/events");
    close(); assert.equal(FakeEventSource.instances[before + 1]!.closed, true);
    FakeEventSource.instances[before + 1]!.fail(); mock.timers.tick(TEAM_EVENTS_RETRY_MS); assert.equal(FakeEventSource.instances.length, before + 2, "once closed by the page, nothing reopens");
  } finally { mock.timers.reset(); }
});

test("the owner app's team topic says hello without a count, so the rail badge is fetched at once and after every reconnect", async () => {
  inboxUnread.value = 0;
  const before = FakeEventSource.instances.length;
  watchTeam(); watchTeam(); // once; the second call is a no-op
  await settle(); await settle();
  const source = FakeEventSource.instances[before]!; assert.equal(FakeEventSource.instances.length, before + 1, "the owner app shares one multiplexed stream");
  const url = new URL(source.url, "http://localhost"); assert.equal(url.pathname, "/api/stream"); assert.deepEqual(JSON.parse(url.searchParams.get("subs")!).map((sub: { topic: string }) => sub.topic), ["team"]);
  source.send({ s: 0, d: { type: "hello", client: "c1" } });
  source.send({ s: 1, d: { type: "hello", epoch: "hub-1", seq: 12, linked: false } });
  await answer("/api/team/inbox", { items: [], unread: 3 });
  assert.equal(inboxUnread.value, 3, "the inbox count is loaded from the topic's hello, before any Team page is opened");
  source.send({ s: 1, d: { type: "inbox", seq: 13, unread: 1 } }); assert.equal(inboxUnread.value, 1);
  assert.equal(requests.filter((entry) => entry.url.pathname === "/api/team/inbox" && !entry.done).length, 0, "an inbox frame needs no fetch");
});


test("team server addresses also support configured HTTPS networks without sharing capability paths", () => {
  assert.equal(teamServerAddress({ secure: true, lanUrls: ["https://code.example:4318/r/private-phone-secret"] }), "https://code.example:4318");
  assert.equal(teamServerAddress({ secure: false, lanUrls: ["http://code.example:4318/r/private-phone-secret"] }), undefined);
  assert.equal(teamServerAddress({ secure: true, lanUrls: ["http://code.example:4318/r/private-phone-secret"] }), undefined);
});
