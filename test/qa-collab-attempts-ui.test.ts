import test from "node:test";
import assert from "node:assert/strict";
import type { Attempt, AttemptState } from "../src/collab/model.js";

/**
 * The task page's reading of an attempt, from the QA pass on team attempts: "Connection lost" (silent for 90 s) and
 * "Status unknown" (recorded with a reason) are told apart and both can be recovered, the hints name recovery rather
 * than a stop nobody can make, the page shows a newer outcome over an older paused attempt, and an API refusal keeps
 * the server's `code` so only a stale revision reloads.
 */
// The ui modules expect a browser; the shims match test/collab-ui.test.ts.
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { close() {} } });
let answer: { status: number; body: unknown } = { status: 200, body: {} };
globalThis.fetch = (async () => new Response(JSON.stringify(answer.body), { status: answer.status })) as typeof fetch;
const { ATTEMPT_LABEL, STALE_REVISION, attemptResumable, attemptSilent, attemptStale, busyProblem, currentAttempt, ownerProblem, shownAttempt, transitionProblem } = await import("../ui/collab-state.js");
const { ApiError, api } = await import("../ui/lib.js");

const NOW = 1_000_000_000;
const attempt = (id: string, state: AttemptState, lastHeartbeatAt = NOW): Attempt => ({ id, taskId: "t-0123456789abcdef", runnerId: "r-0123456789abcdef", runnerName: "Bob laptop", user: { userId: "bob", displayName: "Bob" }, state, baseCommit: "a".repeat(40), createdAt: 1, lastSeq: 1, lastHeartbeatAt, progress: { updatedAt: 1 } });

test("a silent running attempt reads Connection lost, an unknown one Status unknown, and both may be recovered", () => {
  const silent = attempt("a1", "running", NOW - 120_000), live = attempt("a2", "running", NOW - 30_000), unknown = attempt("a3", "unknown", NOW);
  assert.equal(attemptSilent(silent, NOW), true); assert.equal(attemptStale(silent, NOW), true, "a Connection lost attempt is recoverable");
  assert.equal(attemptSilent(live, NOW), false); assert.equal(attemptStale(live, NOW), false, "a live runner keeps its attempt");
  assert.equal(attemptSilent(unknown, NOW), false, "an unknown attempt the runner just reported is not 'Connection lost'"); assert.equal(attemptStale(unknown, NOW), true);
  assert.equal(ATTEMPT_LABEL.unknown, "Status unknown");
  for (const state of ["paused", "finished", "failed", "stopped", "superseded"] as const) assert.equal(attemptStale(attempt("x", state, NOW - 999_999), NOW), false, state);
});

test("hints for a busy attempt name recovery once its runner lost contact, and a stop while it is live", () => {
  const silent = attempt("a1", "running", NOW - 120_000), live = attempt("a2", "running", NOW - 1000);
  assert.equal(busyProblem(silent, "changing the owner", NOW), "Recover the attempt on Bob laptop, whose runner lost contact, before changing the owner");
  assert.equal(busyProblem(live, "changing the owner", NOW), "Stop the attempt running on Bob laptop before changing the owner");
  assert.equal(busyProblem(silent, "changing the owner"), "Stop the attempt running on Bob laptop before changing the owner", "without a clock the server's own words");
  const task = { owner: { userId: "bob", displayName: "Bob" }, status: "working" as const, attempts: [silent] };
  assert.equal(ownerProblem(task, "maintainer", "mia", NOW), "Recover the attempt on Bob laptop, whose runner lost contact, before changing the owner");
  assert.equal(transitionProblem(task, "done", "maintainer", undefined, NOW), "Recover the attempt on Bob laptop, whose runner lost contact, before marking the task done");
  assert.equal(ownerProblem({ ...task, attempts: [attempt("a3", "unknown")] }, "maintainer", "mia", NOW), "Recover the attempt on Bob laptop, whose runner lost contact, before changing the owner");
  assert.equal(transitionProblem({ ...task, attempts: [live] }, "done", "maintainer", undefined, NOW), "Stop the attempt running on Bob laptop before marking the task done");
});

test("the Execution card shows a newer finished attempt over an older paused one, and offers no Resume for it", () => {
  const task = { status: "working" as const, attempts: [attempt("a1", "paused"), attempt("a2", "finished")] };
  assert.equal(currentAttempt(task), undefined); assert.equal(shownAttempt(task)?.id, "a2"); assert.equal(attemptResumable(shownAttempt(task)!, task), false);
  assert.equal(shownAttempt({ attempts: [attempt("a1", "paused"), attempt("a2", "superseded")] })?.id, "a1", "a superseded attempt after it does not hide a paused one");
  assert.equal(shownAttempt({ attempts: [attempt("a1", "finished"), attempt("a2", "paused")] })?.id, "a2");
});

test("an API refusal keeps the server's code, so only a stale revision is told apart from a rule", async () => {
  answer = { status: 409, body: { error: "Task changed; reload before saving", code: STALE_REVISION } };
  await assert.rejects(api("/api/team/tasks/t-0123456789abcdef"), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === STALE_REVISION);
  answer = { status: 409, body: { error: "Cancel the offered hand-over before deleting its checkpoint" } };
  await assert.rejects(api("/api/team/checkpoints/x"), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === undefined && error.message === "Cancel the offered hand-over before deleting its checkpoint");
});
